'use strict';

const publicPolicyRoles = require('../storage/postgres-public-policy-roles');
const candidates = require('./postgres-candidate.json').migrations;
const columns = {
  tenant_notification_heads: [
    ['tenant_id', 'uuid', true], ['consumer', 'text', true], ['dedup_key', 'text', true],
    ['request_id', 'uuid', false, true], ['blocked_until', 'bigint', true, true]
  ],
  tenant_notification_requests: [
    ['tenant_id', 'uuid', true], ['request_id', 'uuid', true], ['consumer', 'text', true], ['dedup_key', 'text', true],
    ['origin', 'text', true], ['config_identity', 'text', true], ['payload', 'jsonb', true], ['state', 'text', true, true],
    ['created_at', 'bigint', true], ['next_at', 'bigint', true, true], ['attempt', 'integer', true, true],
    ['attempt_token', 'uuid', false, true], ['attempt_until', 'bigint', false, true], ['accepted_at', 'bigint', false, true],
    ['receipt', 'jsonb', false, true], ['cleared_at', 'bigint', false, true]
  ],
  tenant_notification_state: [['tenant_id', 'uuid', true], ['consumer', 'text', true], ['revision', 'bigint', true, true],
    ['config_identity', 'text', true, true], ['producer', 'jsonb', true, true]],
  schema_migrations: [['name', 'text', true], ['checksum', 'text', true], ['applied_at', 'timestamp with time zone', true]]
};
const keys = { tenant_notification_heads: ['tenant_id', 'consumer', 'dedup_key'],
  tenant_notification_requests: ['tenant_id', 'request_id'], tenant_notification_state: ['tenant_id', 'consumer'], schema_migrations: ['name'] };
const canonical = value => typeof value === 'string' ? value.toLowerCase().replace(/::text/g, '').replace(/[\s()]/g, '') : '';
const tenantPolicy = canonical("tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid");
const fail = () => { throw new Error('NOTIFICATION_SCHEMA_UNSAFE'); };
function shape (row, table, stateReadOnly) {
  const ledger = table === 'schema_migrations', readonly = ledger || stateReadOnly;
  if (!row || row.kind !== 'r' || row.persistence !== 'p' || row.owns || row.schema_writes || !row.reads ||
      row.broad_writes || (readonly ? row.any_writes : !row.inserts) || !Array.isArray(row.columns) ||
      row.columns.length !== columns[table].length || JSON.stringify(row.primary_key) !== JSON.stringify(keys[table])) fail();
  columns[table].forEach(([name, type, notNull, updates], index) => {
    const found = row.columns[index];
    if (!found || found.name !== name || found.type !== type || found.not_null !== notNull ||
        found.updates !== (!readonly && !!updates) || (!readonly && found.inserts !== true)) fail();
  });
  if (!ledger) {
    if (!row.secured || !Array.isArray(row.policies) || row.policies.length !== 1) fail();
    const policy = row.policies[0];
    if (policy.command !== '*' || policy.permissive !== true || !publicPolicyRoles(policy.roles) ||
        canonical(policy.using) !== tenantPolicy || canonical(policy.check) !== tenantPolicy) fail();
  }
}
module.exports = async function assertNotificationReadiness (db, namespace, {stateReadOnly = false, alarmTable, onMetadata, diagnosticMaxRows, diagnosticMaxBytes} = {}) {
  if (typeof stateReadOnly !== 'boolean' || stateReadOnly && (typeof alarmTable !== 'string' || !/^"[a-z][a-z0-9_]{0,62}"\.tenant_alarm_suppression$/.test(alarmTable))) fail();
  const observe = require('../storage/metadata-observer')({onMetadata,maxRows:diagnosticMaxRows,maxBytes:diagnosticMaxBytes});
  const role = (await db.query(`SELECT /* notification-readiness-role */ r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,
    pg_has_role(current_user,n.nspowner,'MEMBER') AS owns_schema,
    has_schema_privilege(n.oid,'USAGE') AS uses_schema,
    has_schema_privilege(n.oid,'CREATE') AS schema_writes,
    has_database_privilege(current_database(),'CREATE') AS database_create,
    EXISTS (SELECT 1 FROM pg_roles elevated WHERE (elevated.rolsuper OR elevated.rolbypassrls OR elevated.rolcreaterole OR elevated.rolcreatedb OR elevated.rolreplication)
      AND pg_has_role(current_user,elevated.oid,'MEMBER')) AS elevated_membership,
    EXISTS (SELECT 1 FROM pg_namespace other WHERE other.nspname !~ '^pg_' AND other.nspname <> 'information_schema'
      AND has_schema_privilege(other.oid,'CREATE')) AS any_schema_writes,
    EXISTS (SELECT 1 FROM pg_class other JOIN pg_namespace space ON space.oid=other.relnamespace
      WHERE space.nspname !~ '^pg_' AND space.nspname <> 'information_schema' AND other.relkind IN ('r','p','v','m','f')
      AND ${stateReadOnly ? 'other.oid<>to_regclass($2)' : "NOT (space.nspname=$1 AND other.relname IN ('tenant_notification_heads','tenant_notification_requests','tenant_notification_state'))"}
      AND (has_table_privilege(other.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
        OR has_any_column_privilege(other.oid,'INSERT,UPDATE,REFERENCES'))) AS foreign_writes
    FROM pg_roles r CROSS JOIN pg_namespace n WHERE r.rolname=current_user AND n.nspname=$1`, stateReadOnly ? [namespace, alarmTable] : [namespace])).rows;
  await observe('role', role);
  if (role.length !== 1 || !role[0].uses_schema || role[0].rolsuper || role[0].rolbypassrls || role[0].rolcreaterole ||
      role[0].rolcreatedb || role[0].rolreplication || role[0].owns_schema || role[0].schema_writes ||
      role[0].any_schema_writes || role[0].database_create || role[0].elevated_membership || role[0].foreign_writes) fail();
  for (const table of stateReadOnly ? ['tenant_notification_state', 'schema_migrations'] : Object.keys(columns)) {
    const rows = (await db.query(`SELECT /* notification-readiness-table */ c.relkind AS kind,c.relpersistence AS persistence,
      c.relrowsecurity AND c.relforcerowsecurity AS secured,pg_has_role(current_user,c.relowner,'MEMBER') AS owns,
      has_schema_privilege(c.relnamespace,'CREATE') AS schema_writes,
      has_table_privilege(c.oid,'SELECT') AS reads,has_table_privilege(c.oid,'INSERT') AS inserts,
      has_table_privilege(c.oid,'UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(c.oid,'REFERENCES') AS broad_writes,
      has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES') AS any_writes,
      (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
        'updates',has_column_privilege(c.oid,a.attname,'UPDATE'),'inserts',has_column_privilege(c.oid,a.attname,'INSERT')) ORDER BY a.attnum)
        FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
      (SELECT jsonb_agg(a.attname ORDER BY k.ordinality) FROM pg_index i,
        unnest(i.indkey) WITH ORDINALITY k(number,ordinality) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.number
        WHERE i.indrelid=c.oid AND i.indisprimary) AS primary_key,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('command',p.polcmd,'roles',p.polroles,'permissive',p.polpermissive,
        'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)))
        FROM pg_policy p WHERE p.polrelid=c.oid),'[]'::jsonb) AS policies
      FROM pg_class c WHERE c.oid=to_regclass($1)`, ['"' + namespace + '".' + table])).rows;
    await observe('table', rows, table);
    if (rows.length !== 1) fail();
    shape(rows[0], table, stateReadOnly);
  }
  const history = (await db.query('SELECT /* notification-readiness-ledger */ name,checksum FROM "' + namespace + '".schema_migrations ORDER BY name')).rows;
  await observe('ledger', history, 'schema_migrations');
  if (history.length !== candidates.length || history.some((row, index) => row.name !== candidates[index].name || row.checksum !== candidates[index].checksum)) fail();
};
