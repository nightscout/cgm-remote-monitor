'use strict';

// Dormant current-state consumer. No listener, timer, notification or DDL.
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const scope = require('./tenant-scope');
const { decodeDocument } = require('./postgres-identity');

const PART = /^[a-z][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = 8640000000000000;

function tableName (name) {
  const parts = typeof name === 'string' ? name.split('.') : [];
  if (parts.length !== 2 || !parts.every(part => PART.test(part)) ||
      parts[0] === 'public' || parts[0].startsWith('pg_') || parts[0] === 'information_schema') {
    throw new TypeError('Durable replay requires explicit non-system schema.table names');
  }
  return parts.map(part => '"' + part + '"').join('.');
}

function stamp (value) {
  const n = Number(value);
  if (!['string', 'number'].includes(typeof value) ||
      (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) ||
      !Number.isSafeInteger(n) || n < 0 || n >= LIMIT) throw new Error('REPLAY_INVALID_STAMP');
  return n;
}

// A change signature: the tenant write clock pair, from a clock row or the
// change-stamp function ({ stamp, deleted } as text or numbers; both required).
function changeSignature (row) {
  return Object.freeze({ stamp: stamp(row.stamp), deleted: stamp(row.deleted) });
}
const sameSignature = (a, b) => !!a && !!b && typeof a === 'object' && typeof b === 'object' &&
  a.stamp === b.stamp && a.deleted === b.deleted;

const windowPolicy = require('./clinical-working-set-policy');
const { Params } = require('./postgres-filter');
const keyOf = row => JSON.stringify([row.domain, row.id_kind, row.doc._id]);

module.exports = function durableReplay ({ connection, checkpointTable, clockTable,
  domains, consumer, projectionVersion, pageSize, maxRows, stream = false } = {}) {
  if (!connection || typeof connection.snapshotTransaction !== 'function' || typeof connection.query !== 'function') {
    throw new TypeError('Durable replay requires an explicit snapshotTransaction capability');
  }
  if (typeof consumer !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(consumer) ||
      typeof projectionVersion !== 'string' || !projectionVersion.length) throw new TypeError('Consumer and projectionVersion required');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || !Number.isSafeInteger(maxRows) ||
      maxRows < pageSize) throw new TypeError('Explicit replay pageSize and maxRows required');
  const checkpoints = tableName(checkpointTable), clock = tableName(clockTable);
  if (!domains || typeof domains !== 'object' || Array.isArray(domains) || !Object.keys(domains).length) {
    throw new TypeError('Explicit replay domains required');
  }
  const entries = Object.entries(domains).sort(([a], [b]) => a.localeCompare(b));
  entries.forEach(([domain, table]) => {
    if (!PART.test(domain)) throw new TypeError('Invalid replay domain');
    tableName(table);
  });
  const domainNames = new Set(entries.map(([domain]) => domain));
  const snapshotDigest = createHash('sha256').update(JSON.stringify([projectionVersion, entries, 'bounded-current-snapshot-v1', ...(stream ? [windowPolicy.KIND, 'native-transaction-v2'] : [])])).digest('hex');
  const digest = createHash('sha256').update(JSON.stringify([projectionVersion, entries])).digest('hex');
  // Domain names and table identifiers were validated before interpolation.
  const source = entries.map(([domain, table]) => "SELECT '" + domain + "'::text AS domain, id_kind, doc, " +
    "CASE WHEN jsonb_typeof(doc->'srvModified')='number' THEN (doc->>'srvModified')::numeric END AS stamp, " +
    "doc->>'_id' AS identity FROM " + tableName(table)).join(' UNION ALL ');
  // The current snapshot also carries each row's per-tenant insertion ordinal
  // (the evaluator's view reads break sort ties on it: decision
  // view-reads-total-order) from the tables whose catalogue has one; a table
  // without one gives NULL. Which tables have it is read once per handle.
  let snapshotSource = null;
  async function snapshotSourceSql () {
    if (snapshotSource) return snapshotSource;
    const tables = entries.map(([, table]) => table.split('.'));
    const found = (await sourceQuery('catalogue',"SELECT table_schema || '.' || table_name AS name FROM information_schema.columns " +
      "WHERE column_name = 'insertion_ordinal' AND (table_schema || '.' || table_name) = ANY($1::text[])",
    [tables.map(parts => parts.join('.'))])).rows.map(row => row.name);
    snapshotSource = entries.map(([domain, table]) => "SELECT '" + domain + "'::text AS domain, id_kind, doc, " +
      "CASE WHEN jsonb_typeof(doc->'srvModified')='number' THEN (doc->>'srvModified')::numeric END AS stamp, " +
      "doc->>'_id' AS identity, " + (found.includes(table) ? 'insertion_ordinal' : 'NULL::bigint') + ' AS ordinal' + (stream ? ',storage_bytes' : '') + ' FROM ' + tableName(table)).join(' UNION ALL ');
    return snapshotSource;
  }
  async function windowSourceSql (policy) {
    const base = await snapshotSourceSql(), params = new Params();
    const sources = entries.map(([domain, table]) => {
      // snapshotSourceSql owns the once-per-handle catalogue observation.
      const fragment = base.split(' UNION ALL ').find(part => part.startsWith("SELECT '" + domain + "'::text"));
      const ordered = !fragment.includes('NULL::bigint AS ordinal');
      const rule = windowPolicy.sql(domain, policy, params);
      return "(SELECT '" + domain + "'::text AS domain,id_kind,doc," +
        "CASE WHEN jsonb_typeof(doc->'srvModified')='number' THEN (doc->>'srvModified')::numeric END AS stamp," +
        "doc->>'_id' AS identity,ordinal,storage_bytes," + rule.guard + ' AS unsortable FROM (SELECT *, ' +
        (ordered ? 'insertion_ordinal' : 'NULL::bigint') + ' AS ordinal FROM ' + tableName(table) +
        ') window_rows WHERE ' + rule.where + rule.tail + ')';
    });
    return { source: sources.join(' UNION ALL '), values: params.values };
  }
  function ordinalOf (value) {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('REPLAY_INVALID_PROJECTION');
    return n;
  }
  // The evaluator's change signature (perf lane EV, D6 backstop): the tenant
  // write clock pair (last_stamp, last_delete_stamp). Decision
  // write-clock-complete: every supported write that changes evaluated input
  // advances last_stamp in its own transaction, hard deletes (which also
  // advance last_delete_stamp) and activity-domain writes included, so the
  // pair moves on every change the evaluator reads. It replaces the row-count
  // and row-version digest scan: one primary-key row under the tenant's RLS
  // binding here, or one statement per member per pass through the change-stamp
  // function (lib/change-stamps), which returns the same pair.
  const signatureSql = 'SELECT /* evaluator-change-signature */ last_stamp::text AS stamp, last_delete_stamp::text AS deleted FROM ' +
    clock + ' WHERE tenant_id=$1';
  function signatureOf (row) {
    if (!row || row.stamp === null || row.stamp === undefined) throw new Error('REPLAY_CLOCK_NOT_PROVISIONED');
    return changeSignature(row);
  }

  // Evaluator cost lane, candidate E: per tenant, the change signature and
  // checkpoint of the last committed signature reconcile on this handle. When
  // the next one finds the same signature, the same checkpoint and contract,
  // and a saved projection, nothing it reads has changed since the projection
  // was last written or verified (every write the evaluator reads advances
  // the clock pair): the saved projection is not read back, deep-compared or
  // copied again. Set only after COMMIT.
  const verified = new Map();

  function validate (row) {
    if (!row || !domainNames.has(row.domain) || !row.doc || typeof row.doc !== 'object') {
      throw new Error('REPLAY_INVALID_PROJECTION');
    }
    decodeDocument(row); // preserves and validates string/ObjectId distinction
    stamp(row.stamp);
    if (stamp(row.doc.srvModified) !== stamp(row.stamp)) throw new Error('REPLAY_INVALID_PROJECTION');
  }

  function output (checkpoint, projection, changed, bootstrapped, ordinals) {
    return { checkpoint, changed, bootstrapped, rows: Array.from(projection.values(), row => ({
      domain: row.domain, document: decodeDocument(row),
      ...(ordinals ? { ordinal: ordinals.has(keyOf(row)) ? ordinals.get(keyOf(row)) : null } : {}),
      ...(stream ? { storageBytes: Number(row.storage_bytes) } : {})
    })) };
  }

  let nativeStream;
  // Cache admission is bounded across tenants as well as within each input.
  // These are encoded-byte bounds; runtime heap overhead is measured separately.
  const inputs=new Map(), sizes=new Map();let inputBytes=0, evictions=0;
  const access={snapshotAttempts:0,snapshotCompleted:0,catalogueAttempts:0,catalogueCompleted:0,dataAttempts:0,dataCompleted:0};
  async function sourceQuery(kind,...args){access[kind+'Attempts']++;const result=await connection.query(...args);access[kind+'Completed']++;return result;}
  const cache={get(tenant){const value=inputs.get(tenant);if(value){inputs.delete(tenant);inputs.set(tenant,value);}return value;},
    delete(tenant){inputBytes-=sizes.get(tenant)||0;sizes.delete(tenant);return inputs.delete(tenant);},set(tenant,input){
    cache.delete(tenant);if(!input.ready)return;
    const bytes=(input.rowBytes??Buffer.byteLength(JSON.stringify(input.rows)))+Buffer.byteLength(JSON.stringify(require('./clinical-stream-state').compact(input)));
    if(bytes>268435456)return;
    inputs.set(tenant,input);sizes.set(tenant,bytes);inputBytes+=bytes;
    while(inputs.size>10000||inputBytes>268435456){cache.delete(inputs.keys().next().value);evictions++;}
  }};
  return Object.freeze({
    sourceAccess:()=>({...access,residentTenants:inputs.size,residentEncodedBytes:inputBytes,evictions}),
    configureStream(binding) {
      if (!stream || !binding?.recovery || typeof binding.expectedSource !== 'object' || typeof binding.assertFence !== 'function' || typeof binding.generation !== 'function') throw new Error('CLINICAL_STREAM_NATIVE_BINDING');
      nativeStream = binding;
    },
    async acceptTransaction(envelope, {routes, observations, invalidateTenants, store, maxTransactionRows, maxTransactionBytes}) {
      if (!nativeStream) throw new Error('CLINICAL_STREAM_NATIVE_BINDING');
      return connection.acceptClinicalTransaction({envelope, routes, observations, invalidateTenants,cache,admits:nativeStream.admits,
        expectedSource:nativeStream.expectedSource, assertFence:async(...args)=>{if(store.available===false)throw new Error('EVALUATOR_OWNER_UNAVAILABLE');return nativeStream.assertFence(...args);}, lockKey:nativeStream.lockKey,
        table:checkpointTable, consumer, snapshotDigest, initialDigest:digest, maxRows, maxBytes:nativeStream.maxBytes,
        completedConsumer:store.consumer, completedDigest:store.digest, maxTransactionRows, maxTransactionBytes});
    },
    digest,
    snapshotDigest,
    stream,
    async invalidateStream (tenant, work) {
      if (!stream) return;
      cache.delete(tenant);
      return connection.acceptClinicalCheckpoint({ table: checkpointTable, consumer, tenant, invalidate: true,
        snapshotDigest, maxRows, maxBytes: 1, lockKey:nativeStream?.lockKey, ...(work ? {completedConsumer:work.consumer,completedDigest:work.digest} : {}) });
    },
    // Current-state acquisition is deliberately separate from stamped catch-up.
    // It scans every admitted typed identity, even when the clock did not move.
    // A checkpoint here is a snapshot floor, not evaluation/delivery completion.
    // `signature: true` (the evaluator) also records the change signature of
    // this snapshot; other consumers (realtime) do not pay for it.
    async reconcile ({ maxRows: rowBound, maxBytes, signature: withSignature = false, policy } = {}) {
      if (!Number.isSafeInteger(rowBound) || rowBound < 1 || rowBound > maxRows ||
          !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new TypeError('Explicit current snapshot row/byte bounds required within replay row bound');
      }
      if (policy) { if (!stream || !withSignature) throw new Error('CLINICAL_WINDOW_STREAM_REQUIRED'); windowPolicy.validate(policy); }
      const tenant = scope.requireTenant('current snapshot reconciliation');
      if (typeof tenant !== 'string' || !UUID.test(tenant)) throw new TypeError('Current snapshot requires UUID tenant binding');
      let signature = null, recoveredInput;
      const read = async (boundary) => {
        const checkpointSelect = 'SELECT checkpoint, contract_digest, ' +
          (stream ? boundary ? 'projection' : 'jsonb_build_array(projection->0) AS projection' : withSignature ? 'projection IS NULL AS empty' : 'projection') + ' FROM ' + checkpoints +
          ' WHERE tenant_id=$1 AND consumer=$2';
        // Ready input is immutable within this snapshot. CDC owns its writes.
        const locked = await connection.query(checkpointSelect + (stream ? '' : ' FOR UPDATE'), [tenant, consumer]);
        if (locked.rows.length !== 1) throw new Error('REPLAY_NOT_PROVISIONED');
        let saved = locked.rows[0], previous = stamp(saved.checkpoint);
        const durableState = stream && saved.projection?.[0]?.kind === require('./clinical-stream-state').KIND ? saved.projection[0] : null;
        const cached=cache.get(tenant);
        const streamState=stream&&require('./clinical-stream-state').matches(cached,durableState)?cached:durableState;
        if (stream && cached && streamState?.ready && saved.contract_digest === snapshotDigest &&
            streamState.stream?.generation === nativeStream?.generation(tenant) &&
            isDeepStrictEqual(streamState.stream?.source_identity, nativeStream?.expectedSource) &&
            (!policy || windowPolicy.compatible(streamState.policy, policy))) {
          const state = policy ? require('./clinical-stream-state').expire(streamState, policy, { maxRows: rowBound, maxBytes })
            : require('./clinical-stream-state').bound(streamState, { maxRows: rowBound, maxBytes });
          return require('./clinical-stream-state').output(state);
        }
        if (stream && !boundary) return {needsNativeSnapshot:true};
        if (stream) {
          // Cold/GAP recovery owns an atomic bootstrap write. Warm reads do not.
          const bootstrapLock = await connection.query(checkpointSelect + ' FOR UPDATE', [tenant, consumer]);
          if (bootstrapLock.rows.length !== 1) throw new Error('REPLAY_NOT_PROVISIONED');
          saved = bootstrapLock.rows[0]; previous = stamp(saved.checkpoint);
        }

        let floor, recoveryWork;
        if (stream) {
          floor = previous;
          const completed = nativeStream.completed?.();
          if(completed){
            const work = require('../pgstream/work-state');
            if(!/^evaluator-[A-Za-z0-9_-]{1,112}$/.test(completed.consumer)||! /^[a-f0-9]{64}$/.test(completed.digest))throw new Error('CLINICAL_STREAM_COMPLETED_BINDING');
            // Input then completed row: the receipt path takes this same order.
            // A completion after export may force RR serialization/refusal;
            // never overwrite it using an earlier imported view.
            const rows=(await connection.query('SELECT contract_digest,work_version,work_observed,work_completed FROM '+checkpoints+' WHERE tenant_id=$1 AND consumer=$2 FOR UPDATE',[tenant,completed.consumer])).rows;
            if(rows.length!==1||rows[0].contract_digest!==completed.digest||rows[0].work_version!==2)throw new Error('CLINICAL_STREAM_COMPLETED_CONTRACT');
            const observed=work.map(rows[0].work_observed).bootstrap, covered=work.map(rows[0].work_completed).bootstrap;
            const observedFloor=observed===undefined?0:stamp(work.version(observed)),coveredFloor=covered===undefined?0:stamp(work.version(covered));
            // Startup already owns bootstrap zero. Reuse a genuinely pending
            // token covering this input; a drained imported rebuild needs fresh work.
            const pending=observed!==undefined&&(covered===undefined||BigInt(observed)>BigInt(covered))&&observedFloor>=previous;
            floor=pending?observedFloor:stamp(Math.max(previous,observedFloor,coveredFloor)+1);
            recoveryWork={consumer:completed.consumer,digest:completed.digest};
          }
          signature = {stamp:floor,deleted:0};
        } else if (withSignature) {
          // The signature's stamp is the clock floor, read in this snapshot
          // (REPEATABLE READ: the same as at the end of the transaction).
          const rows = (await connection.query(signatureSql, [tenant])).rows;
          if (rows.length !== 1) throw new Error('REPLAY_CLOCK_NOT_PROVISIONED');
          signature = signatureOf(rows[0]);
          floor = signature.stamp;
        } else {
          const floorRows = await connection.query('SELECT last_stamp FROM ' + clock + ' WHERE tenant_id=$1', [tenant]);
          if (floorRows.rows.length !== 1) throw new Error('REPLAY_CLOCK_NOT_PROVISIONED');
          floor = stamp(floorRows.rows[0].last_stamp);
        }
        if (previous > floor) throw new Error('REPLAY_CLOCK_REWOUND');
        const last = withSignature ? verified.get(tenant) : undefined;
        const unchanged = !!last && saved.empty === false && saved.contract_digest === snapshotDigest &&
          previous === floor && last.checkpoint === previous && sameSignature(last.signature, signature);
        if (withSignature && !stream && !unchanged) {
          const read = await connection.query('SELECT projection FROM ' + checkpoints +
            ' WHERE tenant_id=$1 AND consumer=$2', [tenant, consumer]);
          if (read.rows.length !== 1) throw new Error('REPLAY_NOT_PROVISIONED');
          saved.projection = read.rows[0].projection;
        }
        // Refuse oversized documents before transferring them into the client.
        // Counts include invalid/soft-deleted rows in the admission bound.
        // COUNT/SUM still scans the full source; SQL cost/cadence are unmeasured.
        const boundedSource = policy ? await windowSourceSql(policy) : null;
        const totals = (await sourceQuery('data','SELECT count(*)::text AS row_count, ' +
          'COALESCE(sum(octet_length(doc::text)),0)::text AS document_bytes FROM (' + (boundedSource?.source || source) + ') snapshot_source', boundedSource?.values || [])).rows[0];
        if (BigInt(totals.row_count) > BigInt(rowBound)) throw new Error('REPLAY_SNAPSHOT_ROW_BOUND');
        if (BigInt(totals.document_bytes) > BigInt(maxBytes)) throw new Error('REPLAY_SNAPSHOT_BYTE_BOUND');
        const projection = new Map(), invalidKeys = [];
        const ordinals = withSignature ? new Map() : null;
        const pageSource = boundedSource?.source || (withSignature ? await snapshotSourceSql() : source);
        let after, scanned = 0;
        for (;;) {
          const values = [...(boundedSource?.values || [])], offset = values.length;
          const continuation = after
            ? ' WHERE (domain COLLATE "C",id_kind COLLATE "C",identity COLLATE "C") > ($' + (offset+1) + '::text COLLATE "C",$' + (offset+2) + '::text COLLATE "C",$' + (offset+3) + '::text COLLATE "C")' : '';
          if (after) values.push(after.domain, after.id_kind, after.doc._id);
          values.push(pageSize);
          const page = await sourceQuery('data','SELECT domain,id_kind,doc,stamp' + (ordinals ? ',ordinal' : '') + (stream ? ',storage_bytes' : '') + (policy ? ',unsortable' : '') + ' FROM (' + pageSource +
            ') snapshot_source' + continuation +
            ' ORDER BY domain COLLATE "C",id_kind COLLATE "C",identity COLLATE "C" LIMIT $' + values.length, values);
          if (!page.rows.length) break;
          for (const row of page.rows) {
            if (row.unsortable) throw new Error('CLINICAL_WINDOW_UNSORTABLE_PROFILE');
            delete row.unsortable;
            if (!row || !domainNames.has(row.domain)) throw new Error('REPLAY_INVALID_PROJECTION');
            if (ordinals) { ordinals.set(keyOf(row), ordinalOf(row.ordinal)); delete row.ordinal; }
            // Missing legacy dates are valid current state, not stamped replay.
            // A present stamp still has to be valid and fenced by this snapshot.
            if (!stream && Object.hasOwn(row.doc, 'srvModified')) {
              validate(row);
              if (stamp(row.stamp) > floor) throw new Error('REPLAY_UNSTAMPED_OR_UNFENCED_ROW');
            } else {
              decodeDocument(row);
              if (!stream && row.stamp !== null) throw new Error('REPLAY_INVALID_PROJECTION');
            }
            if (++scanned > rowBound) throw new Error('REPLAY_SNAPSHOT_ROW_BOUND');
            // Stream working state retains invalid physical rows too: stored-byte
            // statistics and later TOAST-omitting updates still need their history.
            if (stream || row.doc.isValid !== false) {
              if (projection.has(keyOf(row))) throw new Error('REPLAY_INVALID_PROJECTION');
              // Fresh driver rows stay local until the transaction commits.
              projection.set(keyOf(row), row);
            } else invalidKeys.push(keyOf(row));
            after = row;
          }
        }
        const serialized = JSON.stringify(Array.from(projection.values()));
        const result = unchanged
          ? output(floor, projection, false, false, ordinals)
          : output(floor, projection, saved.contract_digest !== snapshotDigest ||
            !isDeepStrictEqual(saved.projection, Array.from(projection.values())), saved.projection === null || saved.contract_digest !== snapshotDigest, ordinals);
        // Bound both persisted input and decoded result envelopes before UPDATE.
        if (Buffer.byteLength(serialized) > maxBytes || Buffer.byteLength(JSON.stringify(result.rows)) > maxBytes) {
          throw new Error('REPLAY_SNAPSHOT_BYTE_BOUND');
        }
        if (stream) {
          const input = require('./clinical-stream-state').bootstrap(streamState, { ...result, signature, stream:boundary, ...(policy ? {policy} : {}) }, { maxRows: rowBound, maxBytes });
          const sameSource = streamState?.stream?.generation === boundary.generation && isDeepStrictEqual(streamState?.stream?.source_identity,boundary.source_identity);
          const tail = sameSource ? 'projection->1' : '$6::jsonb';
          const reset = sameSource ? [] : [JSON.stringify(require('./storage-event-journal').reset(saved.projection?.[1]))];
          const updated = await connection.query('UPDATE ' + checkpoints +
            ' SET checkpoint=$3, projection=jsonb_build_array($4::jsonb->0,'+tail+'), contract_digest=$5 WHERE tenant_id=$1 AND consumer=$2',
          [tenant, consumer, floor, JSON.stringify([require('./clinical-stream-state').compact(input)]), snapshotDigest,...reset]);
          if (updated.rowCount !== 1) throw new Error('REPLAY_CHECKPOINT_NOT_UPDATED');
          if(recoveryWork)await require('../pgstream/work-state').observeInTransaction({client:connection,table:checkpointTable,consumer:recoveryWork.consumer,contractDigest:recoveryWork.digest,observations:[{tenant,observed:{bootstrap:String(floor)}}]});
          const completed = !sameSource && nativeStream.completed?.();
          if(completed){
            const delivery=await connection.query('UPDATE '+checkpoints+' SET delivery_revision=delivery_revision+1 WHERE tenant_id=$1 AND consumer=$2 AND contract_digest=$3',[tenant,completed.consumer,completed.digest]);
            if(delivery.rowCount!==1)throw new Error('STORAGE_EVENT_OUTPUT_CONTRACT');
          }
          recoveredInput=input;
          return require('./clinical-stream-state').output(input);
        }
        if (result.changed || previous !== floor) {
          const updated = await connection.query('UPDATE ' + checkpoints +
            ' SET checkpoint=$3, projection=$4::jsonb, contract_digest=$5 WHERE tenant_id=$1 AND consumer=$2',
          [tenant, consumer, floor, serialized, snapshotDigest]);
          if (updated.rowCount !== 1) throw new Error('REPLAY_CHECKPOINT_NOT_UPDATED');
        }
        // physical/invalidKeys: what an incremental reader needs to notice a
        // later hard delete for callers of the non-stream snapshot contract.
        const snapshot = { ...result, progress: 'current-snapshot', physical: Number(totals.row_count), invalidKeys };
        // The change signature of exactly this snapshot (signature below).
        if (!withSignature) return snapshot;
        return { ...snapshot, signature };
      };
      const acquire = async () => {
        if (stream && !nativeStream) throw new Error('CLINICAL_STREAM_NATIVE_BINDING');
        const warm = await connection.snapshotTransaction(() => read());
        if (!warm.needsNativeSnapshot) return warm;
        access.snapshotAttempts++;
        const recovered=await nativeStream.recovery.withSnapshot({tenant, fn:boundary => read(boundary)});access.snapshotCompleted++;return recovered;
      };
      return acquire().then(value => {
        if(recoveredInput)cache.set(tenant,recoveredInput);
        if (withSignature) verified.set(tenant, Object.freeze({ signature, checkpoint: value.checkpoint }));
        return value;
      }, error => {
        cache.delete(tenant);
        if (withSignature) verified.delete(tenant);
        throw error;
      });
    },
    // Equal to the signature of the last processed reconcile: nothing the
    // evaluator reads has changed since.
    async signature () {
      const tenant = scope.requireTenant('change signature');
      if (typeof tenant !== 'string' || !UUID.test(tenant)) throw new TypeError('Change signature requires UUID tenant binding');
      if(stream){
        const row=(await connection.query("SELECT contract_digest,(projection->0)-'rows' AS input FROM "+checkpoints+' WHERE tenant_id=$1 AND consumer=$2',[tenant,consumer])).rows[0];
        const saved=row?.input,cached=cache.get(tenant);
        const input=require('./clinical-stream-state').matches(cached,saved)?cached:null;
        if(!nativeStream||row?.contract_digest!==snapshotDigest||!input?.ready||input.kind!==require('./clinical-stream-state').KIND||input.stream?.generation!==nativeStream.generation(tenant)||!isDeepStrictEqual(input.stream?.source_identity,nativeStream.expectedSource))throw new Error('CLINICAL_STREAM_BOOTSTRAP_REQUIRED');
        return changeSignature({stamp:input.floor,deleted:input.deleted});
      }
      return signatureOf((await connection.query(signatureSql, [tenant])).rows[0]);
    },
    async catchUp () {
      const tenant = scope.requireTenant('durable replay');
      if (typeof tenant !== 'string' || !UUID.test(tenant)) throw new TypeError('Durable replay requires UUID tenant binding');
      // Result is returned only after snapshotTransaction acknowledges COMMIT.
      return connection.snapshotTransaction(async () => {
        const locked = await connection.query('SELECT checkpoint, contract_digest, projection FROM ' + checkpoints +
          ' WHERE tenant_id=$1 AND consumer=$2 FOR UPDATE', [tenant, consumer]);
        if (locked.rows.length !== 1) throw new Error('REPLAY_NOT_PROVISIONED');
        const saved = locked.rows[0];
        const incompatible = saved.contract_digest !== digest;
        const previous = stamp(saved.checkpoint);
        const floorRows = await connection.query('SELECT last_stamp FROM ' + clock + ' WHERE tenant_id=$1', [tenant]);
        if (floorRows.rows.length !== 1) throw new Error('REPLAY_CLOCK_NOT_PROVISIONED');
        const floor = stamp(floorRows.rows[0].last_stamp);
        if (previous > floor) throw new Error('REPLAY_CLOCK_REWOUND');
        const invalid = await connection.query('SELECT 1 FROM (' + source + ') replay_source WHERE ' +
          'stamp IS NULL OR stamp < 0 OR stamp <> trunc(stamp) OR stamp > $1 LIMIT 1', [floor]);
        if (invalid.rows.length) throw new Error('REPLAY_UNSTAMPED_OR_UNFENCED_ROW');
        const bootstrapped = saved.projection === null || incompatible;
        if (!bootstrapped && !Array.isArray(saved.projection)) throw new Error('REPLAY_INVALID_PROJECTION');
        const projection = new Map();
        for (const row of bootstrapped ? [] : saved.projection) {
          validate(row);
          if (stamp(row.stamp) > previous || row.doc.isValid === false || projection.has(keyOf(row))) {
            throw new Error('REPLAY_INVALID_PROJECTION');
          }
          projection.set(keyOf(row), row);
        }
        if (projection.size > maxRows) throw new Error('REPLAY_ROW_BOUND');
        let after, seen = 0, pending = [], changed = false;
        function apply () {
          if (!pending.length) return;
          for (const row of pending) {
            if (row.doc.isValid === false) projection.delete(keyOf(row));
            else projection.set(keyOf(row), row);
          }
          pending = [];
          changed = true;
          if (projection.size > maxRows) throw new Error('REPLAY_ROW_BOUND');
        }
        for (;;) {
          const values = [bootstrapped ? -1 : previous, floor];
          let continuation = '';
          if (after) {
            values.push(after.stamp, after.domain, after.id_kind, after.doc._id);
            continuation = ' AND (stamp, domain COLLATE "C", id_kind COLLATE "C", identity COLLATE "C") > ' +
              '($3::numeric,$4::text COLLATE "C",$5::text COLLATE "C",$6::text COLLATE "C")';
          }
          values.push(pageSize);
          const page = await connection.query('SELECT domain,id_kind,doc,stamp FROM (' + source +
            ') replay_source WHERE stamp > $1 AND stamp <= $2' + continuation +
            ' ORDER BY stamp,domain COLLATE "C",id_kind COLLATE "C",identity COLLATE "C" LIMIT $' + values.length, values);
          if (!page.rows.length) { apply(); break; }
          for (const row of page.rows) {
            validate(row);
            if (++seen > maxRows) throw new Error('REPLAY_ROW_BOUND');
            if (pending.length && stamp(row.stamp) !== stamp(pending[0].stamp)) apply();
            pending.push(row);
            after = row;
          }
        }
        // The snapshot floor covers every visible stamped row across admitted
        // domains. Rows overwritten before replay converge to their latest state;
        // no intermediate transition or hard-delete recovery is promised.
        const checkpoint = floor;
        if (bootstrapped || changed || checkpoint !== previous) {
          const updated = await connection.query('UPDATE ' + checkpoints +
            ' SET checkpoint=$3, projection=$4::jsonb, contract_digest=$5 WHERE tenant_id=$1 AND consumer=$2',
          [tenant, consumer, checkpoint, JSON.stringify(Array.from(projection.values())), digest]);
          if (updated.rowCount !== 1) throw new Error('REPLAY_CHECKPOINT_NOT_UPDATED');
        }
        return output(checkpoint, projection, changed, bootstrapped);
      });
    }
  });
};
module.exports.changeSignature = changeSignature;
module.exports.sameSignature = sameSignature;
