'use strict';

// Incremental current-state view of one tenant's typed rows (decision
// incremental-refresh). Shared read path for the realtime and evaluator
// consumers; see the interface at the bottom.
//
// Cold start: a full bounded reconcile (postgres-durable-replay reconcile, so
// the consumer's checkpoint bookkeeping is unchanged). Afterwards, one
// REPEATABLE READ snapshot per refresh reads
//   1. the tenant clock pair (decision write-clock-complete): every write,
//      hard deletes included, advances last_stamp; a hard delete also sets
//      last_delete_stamp. A delete stamp past the checkpoint runs a full
//      reconcile (a hard delete leaves no row to read),
//   2. only rows stamped in (checkpoint, floor] (index on "srvModified" where
//      the table has it), applied to the in-memory view: a soft delete
//      (isValid:false) removes the row, anything else replaces it,
//   3. the tenant's physical row count across the domains (index-only).
// A full reconcile also replaces the view when the floor is below the
// checkpoint (a rewind or restore), when more rows changed than the bound (a
// gap), or when the physical count differs from the view's valid + invalid
// rows: a guard for a writer outside the clock (durable event delivery
// contract §4). A consumer refreshes when the floor moved; nothing needs a
// periodic refresh of an unchanged tenant.
const { createHash } = require('node:crypto');
const scope = require('./tenant-scope');
const { encodeDocument, decodeDocument } = require('./postgres-identity');
const PART = /^[a-z][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = 8640000000000000;
function tableName (name) {
  const parts = typeof name === 'string' ? name.split('.') : [];
  if (parts.length !== 2 || !parts.every(part => PART.test(part)) || parts[0] === 'public' || parts[0].startsWith('pg_')) throw new TypeError('Incremental view requires explicit schema.table names');
  return parts.map(part => '"' + part + '"').join('.');
}
function stamp (value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n >= LIMIT) throw new Error('VIEW_INVALID_STAMP');
  return n;
}
const keyOf = (domain, document) => { const id = encodeDocument(document); return JSON.stringify([domain, id.id_kind, id.doc._id]); };
function create ({ connection, domains, indexed = [], clockTable, reconcile, pageSize, maxRows }) {
  if (typeof connection?.snapshotTransaction !== 'function' || typeof reconcile !== 'function' ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || !Number.isSafeInteger(maxRows) || maxRows < pageSize ||
      !domains || typeof domains !== 'object' || !Object.keys(domains).length) throw new TypeError('Incremental view requires a snapshot connection, reconcile and bounds');
  const entries = Object.entries(domains).sort(([a], [b]) => a.localeCompare(b));
  entries.forEach(([domain, table]) => { if (!PART.test(domain)) throw new TypeError('Invalid view domain'); tableName(table); });
  const clock = tableName(clockTable), withColumn = new Set(indexed);
  // Domain names and table identifiers were validated before interpolation.
  const changedSource = entries.map(([domain, table]) => {
    const column = withColumn.has(domain) ? '"srvModified"'
      : "(CASE WHEN jsonb_typeof(doc->'srvModified')='number' THEN (doc->>'srvModified')::numeric END)";
    return "SELECT '" + domain + "'::text AS domain, id_kind, doc, " + column + ' AS stamp, "_id" AS identity FROM ' + tableName(table) +
      ' WHERE tenant_id = $1 AND ' + column + ' > $2 AND ' + column + ' <= $3';
  }).join(' UNION ALL ');
  const countSql = 'SELECT (' + entries.map(([, table]) => '(SELECT count(*) FROM ' + tableName(table) + ' WHERE tenant_id = $1)').join(' + ') + ')::text AS n';
  let state = null;
  const counters = { full: 0, incremental: 0, unchanged: 0, gaps: 0, mismatches: 0, deletes: 0, absences: 0, rowsRead: 0 };
  async function full (reason) {
    counters.full++; if (reason) counters[reason]++;
    const recovered = await reconcile();
    const rows = new Map();
    for (const row of recovered.rows) rows.set(keyOf(row.domain, row.document), row);
    if (!Number.isSafeInteger(recovered.physical) || !Array.isArray(recovered.invalidKeys)) throw new Error('VIEW_RECONCILE_INCOMPLETE');
    state = { checkpoint: stamp(recovered.checkpoint), rows, invalid: new Set(recovered.invalidKeys) };
    return result('full', recovered.rows.length);
  }
  function result (mode, changed) {
    return Object.freeze({ mode, changed, checkpoint: state.checkpoint, rows: Array.from(state.rows.values()) });
  }
  async function refresh () {
    const tenant = scope.requireTenant('incremental view');
    if (typeof tenant !== 'string' || !UUID.test(tenant)) throw new TypeError('Incremental view requires a UUID tenant binding');
    if (!state) return full();
    const previous = state.checkpoint;
    const read = await connection.snapshotTransaction(async () => {
      const floorRows = await connection.query('SELECT last_stamp, last_delete_stamp FROM ' + clock + ' WHERE tenant_id=$1', [tenant]);
      if (floorRows.rows.length !== 1) throw new Error('VIEW_CLOCK_NOT_PROVISIONED');
      const floor = stamp(floorRows.rows[0].last_stamp);
      if (floor < previous) return { verdict: 'mismatches' };
      if (stamp(floorRows.rows[0].last_delete_stamp) > previous) return { verdict: 'deletes' };
      const changed = [];
      if (floor > previous) {
        let after = null;
        for (;;) {
          const values = [tenant, previous, floor];
          let continuation = '';
          if (after) {
            values.push(after.stamp, after.domain, after.id_kind, after.identity);
            continuation = ' WHERE (stamp, domain COLLATE "C", id_kind COLLATE "C", identity COLLATE "C") > ($4::numeric, $5::text COLLATE "C", $6::text COLLATE "C", $7::text COLLATE "C")';
          }
          values.push(pageSize);
          const page = await connection.query('SELECT domain, id_kind, doc, stamp::text AS stamp, identity FROM (' + changedSource + ') changed' + continuation +
            ' ORDER BY stamp, domain COLLATE "C", id_kind COLLATE "C", identity COLLATE "C" LIMIT $' + values.length, values);
          if (!page.rows.length) break;
          changed.push(...page.rows);
          if (changed.length > maxRows) return { verdict: 'gaps' };
          after = page.rows.at(-1);
        }
      }
      const physical = Number((await connection.query(countSql, [tenant])).rows[0].n);
      return { verdict: 'ok', floor, changed, physical };
    });
    if (read.verdict !== 'ok') return full(read.verdict);
    // Apply in stamp order onto a copy: a failed refresh leaves the view as published.
    const rows = new Map(state.rows), invalid = new Set(state.invalid);
    for (const row of read.changed) {
      if (stamp(row.stamp) > read.floor || !row.doc || typeof row.doc !== 'object') throw new Error('VIEW_INVALID_ROW');
      const document = decodeDocument({ id_kind: row.id_kind, doc: row.doc });
      const key = keyOf(row.domain, document);
      if (row.doc.isValid === false) { rows.delete(key); invalid.add(key); }
      else { rows.set(key, { domain: row.domain, document }); invalid.delete(key); }
    }
    counters.rowsRead += read.changed.length;
    if (rows.size + invalid.size !== read.physical) return full('absences');
    if (rows.size > maxRows) return full('gaps');
    state = { checkpoint: read.floor, rows, invalid };
    if (read.floor === previous) { counters.unchanged++; return result('unchanged', 0); }
    counters.incremental++;
    return result('incremental', read.changed.length);
  }
  return Object.freeze({
    refresh,
    reset () { state = null; },
    stats: () => Object.freeze({ ...counters }),
    digest: createHash('sha256').update(JSON.stringify(['incremental-view-v2', entries, [...withColumn].sort()])).digest('hex')
  });
}
// Interface (shared by realtime and evaluator):
//   create({ connection, domains: {logical: 'schema.table'}, indexed: [logical
//     domains whose table has the generated "srvModified" column], clockTable,
//     reconcile: () => replay.reconcile({ maxRows, maxBytes }), pageSize, maxRows })
//   view.refresh() inside the tenant binding -> { mode: 'full' | 'incremental'
//     | 'unchanged', changed, checkpoint, rows: [{ domain, document }] }
//   view.reset() forces the next refresh to be full (lifecycle invalidation).
module.exports = { create };
