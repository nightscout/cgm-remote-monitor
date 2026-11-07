'use strict';

const scope = require('../storage/tenant-scope');
const c = require('./contract');

function connection (value, method) {
  if (typeof value?.query !== 'function' || typeof value?.[method] !== 'function') throw new TypeError('Alarm state requires explicit tenant transaction capability');
}
async function assertPrivileges (db, table, writer) {
  const result = await db.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured,
    pg_has_role(current_user,c.relowner,'MEMBER') AS owns,
    has_table_privilege(c.oid,'SELECT') AS reads,
    has_table_privilege(c.oid,'INSERT') AS inserts,
    has_column_privilege(c.oid,'acked_at','UPDATE') AND has_column_privilege(c.oid,'expires_at','UPDATE') AS state_updates,
    has_table_privilege(c.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES') OR
      has_any_column_privilege(c.oid,'REFERENCES') OR has_table_privilege(c.oid,'UPDATE') OR
      has_column_privilege(c.oid,'tenant_id','UPDATE') OR has_column_privilege(c.oid,'alarm_group','UPDATE') OR
      has_column_privilege(c.oid,'alarm_level','UPDATE') AS broad_writes,
    has_table_privilege(c.oid,'INSERT,UPDATE') OR has_any_column_privilege(c.oid,'INSERT,UPDATE') AS any_writes,
    has_schema_privilege(c.relnamespace,'CREATE') AS schema_writes
    FROM pg_class c WHERE c.oid=to_regclass($1)`, [table]);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row.secured || row.owns || !row.reads || row.broad_writes || row.schema_writes ||
      (writer ? !row.inserts || !row.state_updates : row.any_writes)) c.fail('ALARM_PRIVILEGES_UNSAFE');
}
function createWriter ({ connection: db, namespace, authorizeInTransaction, admitAckInTransaction } = {}) {
  connection(db, 'transaction');
  if (typeof authorizeInTransaction !== 'function') throw new TypeError('Alarm writer requires current transaction-bound authority');
  if (admitAckInTransaction !== undefined && typeof admitAckInTransaction !== 'function') throw new TypeError('Explicit optional ACK admission capability required');
  const table = c.table(namespace);
  async function upsert (tenant, group, level, at, expiry) {
    const saved = await db.query('INSERT INTO ' + table + ' AS existing (tenant_id,alarm_group,alarm_level,acked_at,expires_at)' +
      ' VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,alarm_group,alarm_level) DO UPDATE' +
      ' SET acked_at=EXCLUDED.acked_at,expires_at=EXCLUDED.expires_at WHERE existing.expires_at <= EXCLUDED.acked_at' +
      ' RETURNING tenant_id,alarm_group,alarm_level,acked_at,expires_at', [tenant, group, level, at, expiry]);
    if (saved.rows.length === 1) return { accepted: true, row: c.row(saved.rows[0], tenant) };
    if (saved.rows.length) c.fail('ALARM_PERSISTENCE_INVALID');
    const previous = await db.query('SELECT tenant_id,alarm_group,alarm_level,acked_at,expires_at FROM ' + table +
      ' WHERE tenant_id=$1 AND alarm_group=$2 AND alarm_level=$3', [tenant, group, level]);
    if (previous.rows.length !== 1) c.fail('ALARM_PERSISTENCE_INVALID');
    return { accepted: false, row: c.row(previous.rows[0], tenant) };
  }
  return Object.freeze({
    async ack (operation) {
      const tenant = c.tenant(operation?.tenant), input = c.args(operation?.args);
      return scope.withTenant(tenant, () => db.transaction(async () => {
        // Admission is repeated inside the write boundary using the original
        // socket credential. A transport identity is never client authority.
        await assertPrivileges(db, table, true);
        if (await authorizeInTransaction({ connection: db, operation }) !== true) c.fail('ALARM_AUTHORITY_REFUSED');
        const time = await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms');
        if (time.rows.length !== 1) c.fail('ALARM_TIME_INVALID');
        let at = c.storedInstant(time.rows[0].now_ms);
        // Selected producer state is locked before any suppression row write.
        if (admitAckInTransaction) {
          const decision = await admitAckInTransaction({connection: db, operation, at});
          if (!decision || typeof decision.accepted !== 'boolean') c.fail('ALARM_ADMISSION_INVALID');
          at = c.storedInstant(decision.at);
          if (!decision.accepted) return Object.freeze({accepted:false,rows:Object.freeze([])});
          // The selected state fence may have waited: original socket authority
          // must still be current before the suppression mutation.
          if (await authorizeInTransaction({connection:db,operation}) !== true) c.fail('ALARM_AUTHORITY_REFUSED');
        }
        const expiry = c.instant(at + input.duration);
        const primary = await upsert(tenant, input.group, input.level, at, expiry);
        const rows = [primary.row];
        // Legacy ack returns before recursion during an active level-2 window.
        if (primary.accepted && input.level === 2) rows.push((await upsert(tenant, input.group, 1, at, expiry)).row);
        return Object.freeze({ accepted: primary.accepted, rows: Object.freeze(rows) });
      })); // Never return success before the connection confirms COMMIT.
    }
  });
}
function createReader ({ connection: db, namespace, maxRows, maxBytes } = {}) {
  connection(db, 'snapshotTransaction');
  const table = c.table(namespace);
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Alarm reader requires explicit row/byte bounds');
  const reader = {
    async read ({ tenant: rawTenant, at }) {
      const tenant = c.tenant(rawTenant); c.instant(at);
      return scope.withTenant(tenant, () => db.snapshotTransaction(async () => {
        await assertPrivileges(db, table, false);
        // Equality remains suppressed: legacy emission requires cycle time > expiry.
        const found = await db.query('SELECT tenant_id,alarm_group,alarm_level,acked_at,expires_at FROM ' + table +
          ' WHERE tenant_id=$1 AND expires_at >= $2 ORDER BY alarm_group COLLATE "C",alarm_level LIMIT $3', [tenant, at, maxRows + 1]);
        if (found.rows.length > maxRows) c.fail('ALARM_READ_ROW_BOUND');
        const rows = found.rows.map(row => c.row(row, tenant));
        if (Buffer.byteLength(JSON.stringify(rows)) > maxBytes) c.fail('ALARM_READ_BYTE_BOUND');
        return Object.freeze(rows);
      }));
    },
    async allows ({ tenant, notification, at }) {
      const rows = await reader.read({ tenant, at });
      return require('./cycle').filterEmitted([notification], rows, { tenant, at }).length === 1;
    }
  };
  return Object.freeze(reader);
}
module.exports = { createWriter, createReader };
