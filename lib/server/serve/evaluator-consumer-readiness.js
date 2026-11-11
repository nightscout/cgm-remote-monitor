'use strict';

const publicPolicyRoles = require('../../storage/postgres-public-policy-roles');
const { randomBytes } = require('node:crypto');
const scope = require('../../storage/tenant-scope');
const candidate = require('../../../migrations/candidates/postgres-alarm-suppression-v1.json').migrations[0];
const fail = () => { throw new Error('EVALUATOR_CONSUMER_READINESS_REFUSED'); };
const canonical = value => typeof value === 'string' ? value.toLowerCase().replace(/::text/g, '').replace(/[\s()]/g, '') : '';
const policy = canonical("tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid");

// A transaction-scoped random advisory-lock challenge proves these ACTUAL
// selected connections reach the admitted database. No credential URL equality,
// permanent row/DDL write or elevated pg_control_system permission is needed.
async function sameDatastore (clinical, targets, tenant) {
  if (targets.some(target => target === clinical) || new Set(targets).size !== targets.length) fail();
  const key = randomBytes(8).readBigInt64BE().toString();
  await scope.withTenant(tenant, () => clinical.transaction(async () => {
    await clinical.query('SELECT /* evaluator-consumer-datastore-owner */ pg_advisory_xact_lock($1::bigint)', [key]);
    for (const target of targets) await target.transaction(async () => {
      const result = await target.query('SELECT /* evaluator-consumer-datastore-challenge */ pg_try_advisory_xact_lock($1::bigint) AS acquired', [key]);
      if (result.rows.length !== 1 || result.rows[0].acquired !== false) fail();
    });
  })); // Every challenge lock is released by COMMIT/ROLLBACK, including refusal.
}
async function suppression (connection, namespace, {onMetadata,diagnosticMaxRows,diagnosticMaxBytes,operationWindow} = {}) {
  const observe = require('../../storage/metadata-observer')({onMetadata,maxRows:diagnosticMaxRows,maxBytes:diagnosticMaxBytes});
  const control = await require('../../storage/postgres-operation-control')(connection, operationWindow);
  const table = '"' + namespace + '".tenant_alarm_suppression', ledger = '"' + namespace + '".schema_migrations';
  const roles = (await connection.query(`SELECT /* evaluator-consumer-suppression-role */ r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,
    pg_has_role(current_user,n.nspowner,'MEMBER') AS owns_schema,has_schema_privilege(n.oid,'USAGE') AS uses_schema,
    has_database_privilege(current_database(),'CREATE') AS database_create,
    EXISTS(SELECT 1 FROM pg_roles other WHERE pg_has_role(current_user,other.oid,'MEMBER') AND
      (other.rolname ~ '^pg_' OR other.rolsuper OR other.rolbypassrls OR other.rolcreaterole OR other.rolcreatedb OR other.rolreplication)) AS operator,
    EXISTS(SELECT 1 FROM pg_namespace space WHERE space.nspname !~ '^pg_' AND space.nspname<>'information_schema' AND has_schema_privilege(space.oid,'CREATE')) AS creates,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace space ON space.oid=c.relnamespace WHERE space.nspname !~ '^pg_' AND space.nspname<>'information_schema'
      AND c.relkind IN ('r','p','v','m','f') AND (pg_has_role(current_user,c.relowner,'MEMBER') OR
        has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES') OR
        (c.oid<>to_regclass($2) AND c.oid<>to_regclass($3) AND NOT ((space.nspname||'.'||c.relname)=ANY($4::text[])) AND (has_table_privilege(c.oid,'SELECT') OR has_any_column_privilege(c.oid,'SELECT'))))) AS unrelated
    FROM pg_roles r CROSS JOIN pg_namespace n WHERE r.rolname=current_user AND n.nspname=$1`, [namespace, table, ledger, control])).rows;
  await observe('role', roles);
  if (roles.length !== 1 || !roles[0].uses_schema || Object.entries(roles[0]).some(([key, value]) => key !== 'uses_schema' && value)) fail();
  const schema = (await connection.query(`SELECT /* evaluator-consumer-suppression-shape */ c.relkind AS kind,c.relpersistence AS persistence,
    c.relrowsecurity AND c.relforcerowsecurity AS secured,
    (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum)
      FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
    (SELECT jsonb_agg(a.attname ORDER BY k.ordinality) FROM pg_index i,
      unnest(i.indkey) WITH ORDINALITY k(number,ordinality) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.number
      WHERE i.indrelid=c.oid AND i.indisprimary) AS primary_key,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('command',p.polcmd,'roles',p.polroles,'permissive',p.polpermissive,
      'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))) FROM pg_policy p WHERE p.polrelid=c.oid),'[]'::jsonb) AS policies
    FROM pg_class c WHERE c.oid=to_regclass($1)`, [table])).rows;
  await observe('table', schema, 'tenant_alarm_suppression');
  const expected = [['tenant_id', 'uuid', true], ['alarm_group', 'text', true], ['alarm_level', 'integer', true], ['acked_at', 'bigint', true], ['expires_at', 'bigint', true]];
  const row = schema[0], p = row?.policies?.[0];
  if (schema.length !== 1 || row.kind !== 'r' || row.persistence !== 'p' || !row.secured ||
      JSON.stringify(row.columns) !== JSON.stringify(expected) || JSON.stringify(row.primary_key) !== '["tenant_id","alarm_group","alarm_level"]' ||
      row.policies.length !== 1 || p.command !== '*' || p.permissive !== true || !publicPolicyRoles(p.roles) ||
      canonical(p.using) !== policy || canonical(p.check) !== policy) fail();
  const rows = (await connection.query('SELECT /* evaluator-consumer-suppression-ledger */ name,checksum FROM ' + ledger + ' ORDER BY name')).rows;
  await observe('ledger', rows, 'schema_migrations');
  if (rows.length !== 1 || rows[0].name !== candidate.name || rows[0].checksum !== candidate.checksum) fail();
}
// Decision admission-epoch-everywhere: the per-snapshot suppression guard runs the
// full check above only when the database reports, inside the reader's snapshot,
// a catalogue epoch this guard has not admitted (operation-window-epoch.js, with
// the suppression table and ledger joined to the window's control relations and
// the whole-catalogue sweep its `unrelated` check needs). The epoch is cached only
// if it is unchanged after the full check. Without a window every read runs the
// full check, as before.
function suppressionGuard (connection, namespace, options = {}) {
  const { operationWindow } = options;
  const admitted = new Set();
  let statement = null;
  async function epoch () {
    const row = (await connection.query(statement)).rows[0];
    if (!row || typeof row.epoch !== 'string' || !/^[0-9a-f]{64}$/.test(row.epoch)) fail();
    return row.epoch;
  }
  return async function check () {
    if (!operationWindow) return suppression(connection, namespace, options);
    if (!statement) {
      await suppression(connection, namespace, options);
      const oids = (await connection.query('SELECT /* evaluator-consumer-suppression-oids */ to_regclass($1)::oid::int AS suppression,to_regclass($2)::oid::int AS ledger',
        ['"' + namespace + '".tenant_alarm_suppression', '"' + namespace + '".schema_migrations'])).rows[0];
      if (!oids || !oids.suppression || !oids.ledger || !operationWindow.identity) fail();
      const text = 'SELECT /* evaluator-consumer-suppression-epoch */ ' + require('../../tenant-lifecycle/operation-window-epoch').sql(operationWindow.namespace, true, operationWindow.identity,
        [{ namespace, table: 'tenant_alarm_suppression', oid: oids.suppression }, { namespace, table: 'schema_migrations', oid: oids.ledger }]) + ' AS epoch';
      statement = { name: 'ns_suppression_' + require('node:crypto').createHash('sha256').update(text).digest('hex').slice(0, 24), text };
    }
    const before = await epoch();
    if (admitted.has(before)) return;
    await suppression(connection, namespace, options);
    if (await epoch() !== before) fail();
    if (admitted.size >= 16) admitted.delete(admitted.values().next().value);
    admitted.add(before);
  };
}
module.exports = { sameDatastore, suppression, suppressionGuard };
