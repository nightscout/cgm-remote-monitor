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

const keyOf = row => JSON.stringify([row.domain, row.id_kind, row.doc._id]);
const clone = value => JSON.parse(JSON.stringify(value));

module.exports = function durableReplay ({ connection, checkpointTable, clockTable,
  domains, consumer, projectionVersion, pageSize, maxRows } = {}) {
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

  function validate (row) {
    if (!row || !domainNames.has(row.domain) || !row.doc || typeof row.doc !== 'object') {
      throw new Error('REPLAY_INVALID_PROJECTION');
    }
    decodeDocument(row); // preserves and validates string/ObjectId distinction
    stamp(row.stamp);
    if (stamp(row.doc.srvModified) !== stamp(row.stamp)) throw new Error('REPLAY_INVALID_PROJECTION');
  }

  function output (checkpoint, projection, changed, bootstrapped) {
    return { checkpoint, changed, bootstrapped, rows: Array.from(projection.values(), row => ({
      domain: row.domain, document: decodeDocument(row)
    })) };
  }

  return Object.freeze({
    digest,
    snapshotDigest,
    // Current-state acquisition is deliberately separate from stamped catch-up.
    // It scans every admitted typed identity, even when the clock did not move.
    // A checkpoint here is a snapshot floor, not evaluation/delivery completion.
    async reconcile ({ maxRows: rowBound, maxBytes } = {}) {
      if (!Number.isSafeInteger(rowBound) || rowBound < 1 || rowBound > maxRows ||
          !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new TypeError('Explicit current snapshot row/byte bounds required within replay row bound');
      }
      const tenant = scope.requireTenant('current snapshot reconciliation');
      if (typeof tenant !== 'string' || !UUID.test(tenant)) throw new TypeError('Current snapshot requires UUID tenant binding');
      return connection.snapshotTransaction(async () => {
        const locked = await connection.query('SELECT checkpoint, contract_digest, projection FROM ' + checkpoints +
          ' WHERE tenant_id=$1 AND consumer=$2 FOR UPDATE', [tenant, consumer]);
        if (locked.rows.length !== 1) throw new Error('REPLAY_NOT_PROVISIONED');
        const saved = locked.rows[0], previous = stamp(saved.checkpoint);
        const floorRows = await connection.query('SELECT last_stamp FROM ' + clock + ' WHERE tenant_id=$1', [tenant]);
        if (floorRows.rows.length !== 1) throw new Error('REPLAY_CLOCK_NOT_PROVISIONED');
        const floor = stamp(floorRows.rows[0].last_stamp);
        if (previous > floor) throw new Error('REPLAY_CLOCK_REWOUND');
        // Refuse oversized documents before transferring them into the client.
        // Counts include invalid/soft-deleted rows in the admission bound.
        // COUNT/SUM still scans the full source; SQL cost/cadence are unmeasured.
        const totals = (await connection.query('SELECT count(*)::text AS row_count, ' +
          'COALESCE(sum(octet_length(doc::text)),0)::text AS document_bytes FROM (' + source + ') snapshot_source')).rows[0];
        if (BigInt(totals.row_count) > BigInt(rowBound)) throw new Error('REPLAY_SNAPSHOT_ROW_BOUND');
        if (BigInt(totals.document_bytes) > BigInt(maxBytes)) throw new Error('REPLAY_SNAPSHOT_BYTE_BOUND');
        const projection = new Map();
        let after, scanned = 0;
        for (;;) {
          const values = [], continuation = after
            ? ' WHERE (domain COLLATE "C",id_kind COLLATE "C",identity COLLATE "C") > ($1::text COLLATE "C",$2::text COLLATE "C",$3::text COLLATE "C")' : '';
          if (after) values.push(after.domain, after.id_kind, after.doc._id);
          values.push(pageSize);
          const page = await connection.query('SELECT domain,id_kind,doc,stamp FROM (' + source +
            ') snapshot_source' + continuation +
            ' ORDER BY domain COLLATE "C",id_kind COLLATE "C",identity COLLATE "C" LIMIT $' + values.length, values);
          if (!page.rows.length) break;
          for (const row of page.rows) {
            if (!row || !domainNames.has(row.domain)) throw new Error('REPLAY_INVALID_PROJECTION');
            decodeDocument(row);
            // Missing legacy dates are valid current state, not stamped replay.
            // A present stamp still has to be valid and fenced by this snapshot.
            if (Object.hasOwn(row.doc, 'srvModified')) {
              validate(row);
              if (stamp(row.stamp) > floor) throw new Error('REPLAY_UNSTAMPED_OR_UNFENCED_ROW');
            } else if (row.stamp !== null) throw new Error('REPLAY_INVALID_PROJECTION');
            if (++scanned > rowBound) throw new Error('REPLAY_SNAPSHOT_ROW_BOUND');
            if (row.doc.isValid !== false) {
              if (projection.has(keyOf(row))) throw new Error('REPLAY_INVALID_PROJECTION');
              projection.set(keyOf(row), clone(row));
            }
            after = row;
          }
        }
        const serialized = JSON.stringify(Array.from(projection.values()));
        const result = output(floor, projection, saved.contract_digest !== snapshotDigest ||
          !isDeepStrictEqual(saved.projection, Array.from(projection.values())), saved.projection === null || saved.contract_digest !== snapshotDigest);
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
        return { ...result, progress: 'current-snapshot' };
      });
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
            else projection.set(keyOf(row), clone(row));
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
