'use strict';
// Answers the startup schema-baseline queries (lib/pgstream/schema-baseline.js)
// for source-only fixtures. Returns undefined for any other statement.
// position may be a string or a function returning a string or a promise.
function answer (sql, values, { position = '0/40', running = () => 0, snapshot = '100:105:101,103', calls } = {}) {
  if (sql.includes('pg_current_wal_insert_lsn')) {
    calls?.push('position');
    return Promise.resolve(typeof position === 'function' ? position() : position).then(value => ({ rows: [{ position: value }] }));
  }
  if (sql.includes('pg_current_snapshot()')) { calls?.push('snapshot'); return { rows: [{ snapshot }] }; }
  if (sql.includes('pg_snapshot_xip')) {
    calls?.push('running');
    if (values?.[0] !== snapshot) throw new Error('BASELINE_SNAPSHOT_MISMATCH');
    return { rows: [{ running: running() }] };
  }
  return undefined;
}
module.exports = { answer };
