'use strict';

// Guard an explicitly selected owned namespace; metadata discovery never adopts,
// exports, drops or grants rights to an unreviewed relation. Caller holds the
// snapshot/transaction and coordinated no-DDL operator window. This is not a DDL
// fence against a concurrent privileged actor. No serving role gains privileges.
async function assertRelationInventory (connection, { namespace, tables, infrastructure = null, fail }) {
  if (typeof fail !== 'function') throw new TypeError('Explicit relation refusal factory required');
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(namespace || '') || !Array.isArray(tables) || !tables.length ||
      tables.some(name => !/^[a-z][a-z0-9_]{0,62}$/.test(name) || name === 'schema_migrations') || new Set(tables).size !== tables.length) throw fail('INVALID', 'inventory');
  const selected = require('../tenant-operations/selected-platform');
  const globalProfile = selected.recognizes(infrastructure);
  if (infrastructure !== null && infrastructure !== undefined && !globalProfile) throw fail('INVALID', 'infrastructure');
  const expected = new Set(['schema_migrations', ...tables]);
  if (globalProfile) expected.add(infrastructure.table);
  const rows = (await connection.query(`SELECT /* reviewed-relation-inventory */ c.relname AS name,c.relkind AS kind,c.relispartition AS partition,
      EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('r','p','f','m','v') ORDER BY c.relname COLLATE "C"`, [namespace])).rows;
  const seen = new Set();
  for (const row of rows) {
    if (!expected.has(row.name) && row.name !== infrastructure?.table) throw fail('UNADMITTED', row.name);
    if (seen.has(row.name) || row.kind !== 'r' || row.partition !== false || row.inherited !== false) throw fail('UNSUPPORTED', row.name);
    if (row.name === infrastructure?.table) {
      if (globalProfile) await selected.assert(connection, infrastructure, namespace, fail);
    }
    seen.add(row.name);
  }
  for (const name of expected) if (!seen.has(name)) throw fail('MISSING', name);
}
module.exports = { assertRelationInventory };
