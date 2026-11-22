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
// Resident window (decision stateful-evaluator-resident-window), behind the
// temporary switch NS_EVALUATOR_RESIDENT_WINDOW=1.
const windowMark = require('../writer-driven/window-mark');
const residentWindow = require('./resident-window');
const { deepFreeze } = require('../data/json-copy');
const RESIDENT_CHECK = 'NS_EVALUATOR_RESIDENT_WINDOW_CHECK_MS';
// How often a resident is compared with a full read: 0 is every read (tests),
// default one hour, at most one day.
function residentCheckMs (source = process.env) {
  const raw = source?.[RESIDENT_CHECK];
  if (raw === undefined || raw === '') return 3600000;
  if (!/^(0|[1-9][0-9]{0,7})$/.test(raw) || Number(raw) > 86400000) throw new TypeError('invalid ' + RESIDENT_CHECK + ': a whole number of milliseconds from 0 to 86400000 is required');
  return Number(raw);
}

module.exports = function durableReplay ({ connection, checkpointTable, clockTable,
  domains, consumer, projectionVersion, pageSize, maxRows, level = null } = {}) {
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
  const snapshotDigest = createHash('sha256').update(JSON.stringify([projectionVersion, entries, 'bounded-current-snapshot-v1'])).digest('hex');
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
      "doc->>'_id' AS identity, " + (found.includes(table) ? 'insertion_ordinal' : 'NULL::bigint') + ' AS ordinal FROM ' + tableName(table)).join(' UNION ALL ');
    return snapshotSource;
  }
  async function windowSourceSql (policy) {
    const base = await snapshotSourceSql(), params = new Params();
    const sources = entries.map(([domain, table]) => {
      // snapshotSourceSql owns the once-per-handle catalogue observation.
      const fragment = base.split(' UNION ALL ').find(part => part.startsWith("SELECT '" + domain + "'::text"));
      const ordered = !fragment.includes('NULL::bigint AS ordinal');
      const rule = windowPolicy.sql(domain, policy, params);
      // Spike S1b: one SELECT per disjoint index-bounded branch (see the policy).
      return rule.branches.map(where => "(SELECT '" + domain + "'::text AS domain,id_kind,doc," +
        "CASE WHEN jsonb_typeof(doc->'srvModified')='number' THEN (doc->>'srvModified')::numeric END AS stamp," +
        "doc->>'_id' AS identity,ordinal,storage_bytes," + rule.guard + ' AS unsortable FROM (SELECT *, ' +
        (ordered ? 'insertion_ordinal' : 'NULL::bigint') + ' AS ordinal FROM ' + tableName(table) +
        ') window_rows WHERE ' + where + rule.tail + ')').join(' UNION ALL ');
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
      ...(ordinals ? { ordinal: ordinals.has(keyOf(row)) ? ordinals.get(keyOf(row)) : null } : {})
    })) };
  }

  const access={snapshotAttempts:0,snapshotCompleted:0,catalogueAttempts:0,catalogueCompleted:0,dataAttempts:0,dataCompleted:0};
  async function sourceQuery(kind,...args){access[kind+'Attempts']++;const result=await connection.query(...args);access[kind+'Completed']++;return result;}
  // Spike S1: level-triggered acquisition. No stream state and no input
  // checkpoint: one REPEATABLE READ snapshot reads the clock floor, the
  // tenant's lifecycle generation and the current clinical window (the cold
  // path's paged scan). level.lifecycleTable names tenant_lifecycle_windows.
  const lifecycle = level ? tableName(level.lifecycleTable) : null;
  // level.work ({ table, consumer }): the evaluator's completed-work row, which
  // carries the writers' window marks. With it and the switch, a level window
  // may be brought up to date from a resident instead of read in full.
  const work = level?.work === undefined ? null : level.work;
  if (work !== null && (!work || Object.keys(work).sort().join(',') !== 'consumer,table' ||
      typeof work.consumer !== 'string' || !/^evaluator-[A-Za-z0-9_-]{1,112}$/.test(work.consumer))) throw new TypeError('Explicit evaluator work row required');
  const workTable = work ? tableName(work.table) : null;
  const residentOn = !!work && (level.resident === undefined ? windowMark.enabled() : level.resident === true);
  const checkMs = residentOn ? (level.checkMs === undefined ? residentCheckMs() : level.checkMs) : null;
  if (residentOn && (!Number.isSafeInteger(checkMs) || checkMs < 0)) throw new TypeError('Bounded resident window check interval required');
  const residentCounters = { full: 0, tail: 0, unchanged: 0, rowsRead: 0, checks: 0, differences: 0, reasons: {} };
  // The window source with each row's stored window time. selected: a resident
  // plan (resident-window.js plan), or null for every domain in full.
  async function residentSourceSql (policy, selected) {
    const base = await snapshotSourceSql(), params = new Params();
    const sources = [];
    for (const [domain, table] of entries) {
      const timed = windowMark.TIMED[domain];
      let tail = '';
      if (selected) {
        if (domain === 'profile') { if (!selected.profile) continue; }
        else if (!timed || selected.from[domain] === undefined) continue;
      }
      const fragment = base.split(' UNION ALL ').find(part => part.startsWith("SELECT '" + domain + "'::text"));
      const ordered = !fragment.includes('NULL::bigint AS ordinal');
      const rule = windowPolicy.sql(domain, policy, params);
      if (selected && timed) {
        const spec = windowPolicy.RANGE[domain];
        tail = ' AND (' + spec.key + ' >= ' + params.add(selected.from[domain]) + spec.cast + ')';
      }
      sources.push(rule.branches.map(where => "(SELECT '" + domain + "'::text AS domain,id_kind,doc," +
        "doc->>'_id' AS identity,ordinal," + rule.guard + ' AS unsortable,' + (timed ? timed.column + '::text' : 'NULL::text') +
        ' AS wt FROM (SELECT *, ' + (ordered ? 'insertion_ordinal' : 'NULL::bigint') + ' AS ordinal FROM ' + tableName(table) +
        ') window_rows WHERE (' + where + ')' + tail + rule.tail + ')').join(' UNION ALL '));
    }
    return { source: sources.join(' UNION ALL '), values: params.values };
  }
  // One bounded statement, as the full window read: the totals gate the join.
  async function residentRows (policy, selected, rowBound, maxBytes) {
    const bounded = await residentSourceSql(policy, selected);
    if (!bounded.source) return [];
    const values = [...bounded.values, rowBound, maxBytes], n = values.length;
    const text = 'WITH w AS MATERIALIZED (SELECT *,doc::text AS doc_text FROM (' + bounded.source + ') window_source), t AS (SELECT count(*) AS row_count,' +
      'COALESCE(sum(octet_length(doc_text)),0) AS document_bytes FROM w) SELECT /* ' + (selected ? 'level-window-tail' : 'level-window-read') + ' */ t.row_count::text AS row_count,' +
      't.document_bytes::text AS document_bytes,w.domain,w.id_kind,w.doc_text,w.ordinal,w.unsortable,w.wt FROM t LEFT JOIN w ON t.row_count<=$' + (n - 1) +
      ' AND t.document_bytes<=$' + n + ' ORDER BY w.domain COLLATE "C",w.id_kind COLLATE "C",w.identity COLLATE "C"';
    const result = await sourceQuery('data', { name: 'level-resident-' + createHash('sha256').update(text).digest('hex').slice(0, 40), text }, values);
    const totals = result.rows[0];
    if (!totals) throw new Error('REPLAY_INVALID_PROJECTION');
    if (BigInt(totals.row_count) > BigInt(rowBound)) throw new Error('REPLAY_SNAPSHOT_ROW_BOUND');
    if (BigInt(totals.document_bytes) > BigInt(maxBytes)) throw new Error('REPLAY_SNAPSHOT_BYTE_BOUND');
    const rows = [];
    for (const row of result.rows) {
      if (row.domain === null) { if (totals.row_count === '0') continue; throw new Error('REPLAY_INVALID_PROJECTION'); }
      if (row.unsortable) throw new Error('CLINICAL_WINDOW_UNSORTABLE_PROFILE');
      if (!domainNames.has(row.domain)) throw new Error('REPLAY_INVALID_PROJECTION');
      if (rows.length >= rowBound) throw new Error('REPLAY_SNAPSHOT_ROW_BOUND');
      // Resident documents outlive the cycle that read them: frozen, so nothing
      // that is handed one can change what a later cycle evaluates.
      rows.push({ domain: row.domain, id_kind: row.id_kind, doc: deepFreeze(JSON.parse(row.doc_text)), ordinal: row.ordinal,
        wt: row.wt, bytes: Buffer.byteLength(row.doc_text) });
    }
    if (String(rows.length) !== totals.row_count) throw new Error('REPLAY_INVALID_PROJECTION');
    residentCounters.rowsRead += rows.length;
    return rows;
  }
  // The level window with a resident: the same snapshot reads the clock floor,
  // the lifecycle generation and the tenant's work row (its versions and the
  // writers' window marks, written in the writers' own transactions), so the
  // marks read are exactly those of the writes this snapshot can see.
  async function residentLevelWindow ({ rowBound, maxBytes, policy, resident, tenant }) {
    return connection.snapshotTransaction(async () => {
      const head = (await sourceQuery('data', 'SELECT /* level-window-head */ c.last_stamp::text AS stamp,c.last_delete_stamp::text AS deleted,' +
        // The rows statements take a generic plan, as the full window read (transaction-local, with this statement).
        "set_config('plan_cache_mode','force_generic_plan',true) AS plan_mode," +
        '(SELECT l.generation::text FROM ' + lifecycle + ' l WHERE l.tenant_id=$1) AS generation,(k.tenant_id IS NOT NULL) AS marked,' +
        'k.work_observed,k.work_completed,k.window_mark_version::text AS mark_version,k.window_mark_full AS mark_full,k.window_mark_profile AS mark_profile,' +
        'k.window_mark_entries::text AS mark_entries,k.window_mark_devicestatus AS mark_devicestatus,k.window_mark_treatments AS mark_treatments FROM ' + clock +
        ' c LEFT JOIN ' + workTable + ' k ON k.tenant_id=c.tenant_id AND k.consumer=$2 AND k.work_version=2 WHERE c.tenant_id=$1', [tenant, work.consumer])).rows[0];
      if (!head) throw new Error('REPLAY_CLOCK_NOT_PROVISIONED');
      if (head.generation === null || head.generation === undefined) throw new Error('LEVEL_WINDOW_LIFECYCLE_NOT_PROVISIONED');
      const signature = signatureOf(head);
      const text = value => value === null || value === undefined ? null : String(value);
      const mark = head.marked !== true || !Array.isArray(head.work_observed) || !Array.isArray(head.work_completed) ? null
        : { observed: head.work_observed.map(text), completed: head.work_completed.map(text), version: text(head.mark_version), full: head.mark_full,
          profile: head.mark_profile, entries: text(head.mark_entries), devicestatus: text(head.mark_devicestatus), treatments: text(head.mark_treatments) };
      const { rows, resident: next, mode } = await residentWindow.read({ resident, tenant, generation: head.generation, policy, mark,
        membership: windowPolicy.membership(policy), checkMs, counters: residentCounters,
        readRows: selected => residentRows(policy, selected, rowBound, maxBytes),
        warn: differences => console.warn('Evaluator resident window differed from a full read; repaired', tenant, differences) });
      if (rows.length > rowBound) throw new Error('REPLAY_SNAPSHOT_ROW_BOUND');
      if (rows.reduce((total, row) => total + row.bytes, 0) > maxBytes) throw new Error('REPLAY_SNAPSHOT_BYTE_BOUND');
      const visible = rows.filter(row => row.doc.isValid !== false);
      return { checkpoint: signature.stamp, progress: 'level-window', changed: true, bootstrapped: false, signature,
        generation: head.generation, policy, expiresAt: residentWindow.nextExpiry(visible, policy),
        rows: visible.map(row => ({ domain: row.domain, document: decodeDocument(row), ordinal: ordinalOf(row.ordinal) })),
        // The byte length of these rows in the evaluator's input text.
        rowTextBytes: residentWindow.textBytes(visible, ordinalOf),
        resident: next, residentMode: mode };
    });
  }
  async function levelWindow ({ maxRows: rowBound, maxBytes, policy, resident }) {
    if (!Number.isSafeInteger(rowBound) || rowBound < 1 || rowBound > maxRows || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new TypeError('Explicit window row/byte bounds required within replay row bound');
    }
    windowPolicy.validate(policy);
    const tenant = scope.requireTenant('level window');
    if (typeof tenant !== 'string' || !UUID.test(tenant)) throw new TypeError('Level window requires UUID tenant binding');
    if (residentOn) return residentLevelWindow({ rowBound, maxBytes, policy, resident: resident ?? null, tenant });
    return connection.snapshotTransaction(async () => {
      const head = (await sourceQuery('data', 'SELECT /* level-window-head */ c.last_stamp::text AS stamp,c.last_delete_stamp::text AS deleted,' +
        '(SELECT l.generation::text FROM ' + lifecycle + ' l WHERE l.tenant_id=$1) AS generation FROM ' + clock + ' c WHERE c.tenant_id=$1', [tenant])).rows[0];
      if (!head) throw new Error('REPLAY_CLOCK_NOT_PROVISIONED');
      if (head.generation === null || head.generation === undefined) throw new Error('LEVEL_WINDOW_LIFECYCLE_NOT_PROVISIONED');
      const signature = signatureOf(head), bounded = await windowSourceSql(policy);
      // Spike S1b: one statement. The window is materialized once; its row and
      // byte totals gate the join, so an over-bound window returns one totals
      // row and no documents (the bounds refuse before transfer, as the
      // separate count did), and no page re-runs the scan.
      // The document is serialized once: its text is both the byte measure and
      // what is returned (jsonb's output form is the same text). A named
      // statement keeps the plan per connection: the text is fixed per handle
      // and policy shape, and only the bounds are parameters.
      const values = [...bounded.values, rowBound, maxBytes], n = values.length;
      const text = 'WITH w AS MATERIALIZED (SELECT *,doc::text AS doc_text FROM (' + bounded.source + ') window_source), t AS (SELECT count(*) AS row_count,' +
        'COALESCE(sum(octet_length(doc_text)),0) AS document_bytes FROM w) SELECT /* level-window-read */ t.row_count::text AS row_count,' +
        't.document_bytes::text AS document_bytes,w.domain,w.id_kind,w.doc_text,w.ordinal,w.unsortable FROM t LEFT JOIN w ON t.row_count<=$' + (n - 1) +
        ' AND t.document_bytes<=$' + n + ' ORDER BY w.domain COLLATE "C",w.id_kind COLLATE "C",w.identity COLLATE "C"';
      // The plan depends only on the shape, never on the bound values (every
      // branch is an index range on a parameter); planning the ~1,000-node
      // filter per cycle cost as much as executing it.
      await sourceQuery('data', "SET LOCAL plan_cache_mode = 'force_generic_plan'");
      const result = await sourceQuery('data', { name: 'level-window-' + createHash('sha256').update(text).digest('hex').slice(0, 40), text }, values);
      const totals = result.rows[0];
      if (!totals) throw new Error('REPLAY_INVALID_PROJECTION');
      if (BigInt(totals.row_count) > BigInt(rowBound)) throw new Error('REPLAY_SNAPSHOT_ROW_BOUND');
      if (BigInt(totals.document_bytes) > BigInt(maxBytes)) throw new Error('REPLAY_SNAPSHOT_BYTE_BOUND');
      const rows = [];
      for (const row of result.rows) {
        if (row.domain === null) { if (totals.row_count === '0') continue; throw new Error('REPLAY_INVALID_PROJECTION'); }
        if (row.unsortable) throw new Error('CLINICAL_WINDOW_UNSORTABLE_PROFILE');
        if (!domainNames.has(row.domain)) throw new Error('REPLAY_INVALID_PROJECTION');
        if (rows.length >= rowBound) throw new Error('REPLAY_SNAPSHOT_ROW_BOUND');
        row.doc = JSON.parse(row.doc_text); delete row.doc_text;
        rows.push(row);
      }
      if (String(rows.length) !== totals.row_count) throw new Error('REPLAY_INVALID_PROJECTION');
      const visible = rows.filter(row => row.doc.isValid !== false);
      return { checkpoint: signature.stamp, progress: 'level-window', changed: true, bootstrapped: false, signature,
        generation: head.generation, policy, expiresAt: windowPolicy.nextExpiry(visible, policy),
        rows: visible.map(row => ({ domain: row.domain, document: decodeDocument(row), ordinal: ordinalOf(row.ordinal) })) };
    });
  }
  return Object.freeze({
    level: !!level,
    window: levelWindow,
    // Whether level windows keep a resident (the caller holds it and passes it back).
    residentWindow: residentOn,
    residentStats: () => ({ ...residentCounters, reasons: { ...residentCounters.reasons } }),
    sourceAccess:()=>({...access}),
    digest,
    snapshotDigest,
    forgetTenant (tenant) { verified.delete(tenant); },
    // Current-state acquisition is deliberately separate from stamped catch-up.
    // It scans every admitted typed identity, even when the clock did not move.
    // A checkpoint here is a snapshot floor, not evaluation/delivery completion.
    // `signature: true` (the evaluator) also records the change signature of
    // this snapshot; other consumers (realtime) do not pay for it.
    async reconcile ({ maxRows: rowBound, maxBytes, signature: withSignature = false } = {}) {
      if (!Number.isSafeInteger(rowBound) || rowBound < 1 || rowBound > maxRows ||
          !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new TypeError('Explicit current snapshot row/byte bounds required within replay row bound');
      }
      const tenant = scope.requireTenant('current snapshot reconciliation');
      if (typeof tenant !== 'string' || !UUID.test(tenant)) throw new TypeError('Current snapshot requires UUID tenant binding');
      let signature = null;
      const read = async () => {
        const checkpointSelect = 'SELECT checkpoint, contract_digest, ' +
          (withSignature ? 'projection IS NULL AS empty' : 'projection') + ' FROM ' + checkpoints +
          ' WHERE tenant_id=$1 AND consumer=$2';
        const locked = await connection.query(checkpointSelect + ' FOR UPDATE', [tenant, consumer]);
        if (locked.rows.length !== 1) throw new Error('REPLAY_NOT_PROVISIONED');
        const saved = locked.rows[0], previous = stamp(saved.checkpoint);
        let floor;
        if (withSignature) {
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
        if (withSignature && !unchanged) {
          const read = await connection.query('SELECT projection FROM ' + checkpoints +
            ' WHERE tenant_id=$1 AND consumer=$2', [tenant, consumer]);
          if (read.rows.length !== 1) throw new Error('REPLAY_NOT_PROVISIONED');
          saved.projection = read.rows[0].projection;
        }
        // Refuse oversized documents before transferring them into the client.
        // Counts include invalid/soft-deleted rows in the admission bound.
        // COUNT/SUM still scans the full source; SQL cost/cadence are unmeasured.
        const totals = (await sourceQuery('data','SELECT count(*)::text AS row_count, ' +
          'COALESCE(sum(octet_length(doc::text)),0)::text AS document_bytes FROM (' + source + ') snapshot_source')).rows[0];
        if (BigInt(totals.row_count) > BigInt(rowBound)) throw new Error('REPLAY_SNAPSHOT_ROW_BOUND');
        if (BigInt(totals.document_bytes) > BigInt(maxBytes)) throw new Error('REPLAY_SNAPSHOT_BYTE_BOUND');
        const projection = new Map(), invalidKeys = [];
        const ordinals = withSignature ? new Map() : null;
        const pageSource = withSignature ? await snapshotSourceSql() : source;
        let after, scanned = 0;
        for (;;) {
          const values = [], offset = 0;
          const continuation = after
            ? ' WHERE (domain COLLATE "C",id_kind COLLATE "C",identity COLLATE "C") > ($' + (offset+1) + '::text COLLATE "C",$' + (offset+2) + '::text COLLATE "C",$' + (offset+3) + '::text COLLATE "C")' : '';
          if (after) values.push(after.domain, after.id_kind, after.doc._id);
          values.push(pageSize);
          const page = await sourceQuery('data','SELECT domain,id_kind,doc,stamp' + (ordinals ? ',ordinal' : '') + ' FROM (' + pageSource +
            ') snapshot_source' + continuation +
            ' ORDER BY domain COLLATE "C",id_kind COLLATE "C",identity COLLATE "C" LIMIT $' + values.length, values);
          if (!page.rows.length) break;
          for (const row of page.rows) {
            if (!row || !domainNames.has(row.domain)) throw new Error('REPLAY_INVALID_PROJECTION');
            if (ordinals) { ordinals.set(keyOf(row), ordinalOf(row.ordinal)); delete row.ordinal; }
            // Missing legacy dates are valid current state, not stamped replay.
            // A present stamp still has to be valid and fenced by this snapshot.
            if (Object.hasOwn(row.doc, 'srvModified')) {
              validate(row);
              if (stamp(row.stamp) > floor) throw new Error('REPLAY_UNSTAMPED_OR_UNFENCED_ROW');
            } else {
              decodeDocument(row);
              if (row.stamp !== null) throw new Error('REPLAY_INVALID_PROJECTION');
            }
            if (++scanned > rowBound) throw new Error('REPLAY_SNAPSHOT_ROW_BOUND');
            if (row.doc.isValid !== false) {
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
      const acquire = () => connection.snapshotTransaction(() => read());
      return acquire().then(value => {
        if (withSignature) verified.set(tenant, Object.freeze({ signature, checkpoint: value.checkpoint }));
        return value;
      }, error => {
        if (withSignature) verified.delete(tenant);
        throw error;
      });
    },
    // Equal to the signature of the last processed reconcile: nothing the
    // evaluator reads has changed since.
    async signature () {
      const tenant = scope.requireTenant('change signature');
      if (typeof tenant !== 'string' || !UUID.test(tenant)) throw new TypeError('Change signature requires UUID tenant binding');
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
