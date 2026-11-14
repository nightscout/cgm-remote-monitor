'use strict';

// Optional shared infrastructure from the reviewed pgstream deployment binding.
// It belongs to the database/bootstrap owner, not a tenant or runtime identity.
// This declaration admits metadata only: no heartbeat row enters an artifact or
// tenant deletion/restore. A clock catalogue must select it explicitly.
const { isDeepStrictEqual } = require('node:util');
const TABLE = 'nightscout_heartbeat';
const contract = 'pgstream-heartbeat-v1';
function forCatalogue (kind, namespace, tables) {
  return kind === 'clock' && Array.isArray(tables) && tables.length === 1 && tables[0] === 'tenant_write_clock'
    ? Object.freeze({ contract, namespace, table: TABLE }) : null;
}
async function assert (connection, declaration, namespace, fail) {
  if (!declaration || declaration.contract !== contract || declaration.namespace !== namespace || declaration.table !== TABLE ||
      Object.keys(declaration).sort().join(',') !== 'contract,namespace,table') throw fail('INVALID', 'infrastructure');
  const name = '"' + namespace + '"."' + TABLE + '"';
  const row = (await connection.query(`SELECT /* pgstream-heartbeat-infrastructure */
    c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AS global,
    c.relowner=(SELECT datdba FROM pg_database WHERE datname=current_database()) AS bootstrap_owned,
    EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid) OR
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal) OR
    EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid) OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid) AS augmented,
    (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'required',a.attnotnull,
      'identity',a.attidentity,'generated',a.attgenerated,'default',EXISTS(SELECT 1 FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum)) ORDER BY a.attnum)
      FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
    (SELECT jsonb_agg(jsonb_build_object('definition',pg_get_constraintdef(k.oid),'validated',k.convalidated,
      'deferred',k.condeferrable OR k.condeferred,'noinherit',k.connoinherit)) FROM pg_constraint k WHERE k.conrelid=c.oid) AS constraints
    FROM pg_class c WHERE c.oid=to_regclass($1)`, [name])).rows[0];
  const columns = [
    { name: 'id', type: 'integer', required: true, identity: '', generated: '', default: false },
    { name: 'revision', type: 'bigint', required: true, identity: '', generated: '', default: false }
  ];
  const constraints = row?.constraints;
  const normalized = Array.isArray(constraints) ? constraints.map(value => value.definition.replace(/\s|[()]/g, '')).sort() : [];
  if (!row?.global || row.bootstrap_owned !== true || row.augmented !== false || !isDeepStrictEqual(row.columns, columns) ||
      !isDeepStrictEqual(normalized, ['CHECKid=1', 'CHECKrevision>=0', 'PRIMARYKEYid']) ||
      constraints.some(value => value.validated !== true || value.deferred !== false || value.noinherit !== value.definition.startsWith('PRIMARY KEY'))) throw fail('INFRASTRUCTURE_UNSUPPORTED', TABLE);
}
module.exports = { TABLE, forCatalogue, assert };
