'use strict';

// Change hints for many tenants in one statement (decision
// change-stamp-definer-function). `tenant_change_stamps(uuid[])` is a SECURITY
// DEFINER function owned by the NOLOGIN catalogue owner: it binds each tenant
// in turn through the same RLS setting the serving paths use (RLS on the clock
// table is unchanged), returns only (tenant_id, last_stamp), and its own
// `SET app.current_tenant_id` keeps that binding from leaking to the caller.
// Provisioning pins its search_path to the clock schema and grants EXECUTE to
// the realtime and evaluator identities only.
//
// Every call also returns the function's catalogue version (pg_proc row
// version plus its owner's attributes), the same idea as the operation
// window's catalogue epoch: a version this reader has not admitted runs the
// full attribute check before any stamp is used, so an altered owner,
// search_path, body, grant or security mode is refused.
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const quote = name => '"' + name + '"';
const refuse = code => Object.assign(new Error(code), { code });
const catalogue = require('./postgres-candidate.json');
const BODY = /AS \$fn\$(.*)\$fn\$$/s.exec(catalogue.migrations[0].up[0])[1];
const RESULT = 'TABLE(tenant_id uuid, last_stamp bigint)';
function create ({ connection, namespace, clockNamespace }) {
  if (typeof connection?.readOnly !== 'function' || !NAME.test(namespace || '') || !NAME.test(clockNamespace || '') ||
      [namespace, clockNamespace].some(name => name === 'public' || name === 'information_schema' || name.startsWith('pg_'))) {
    throw new TypeError('Change-stamp reader requires a read-only connection, its namespace and the clock namespace');
  }
  const signature = namespace + '.tenant_change_stamps(uuid[])';
  const call = 'SELECT f.version, s.tenant_id::text AS tenant, s.last_stamp::text AS stamp FROM (SELECT p.xmin::text || \':\' || r.rolcanlogin::text || r.rolsuper::text || r.rolbypassrls::text AS version' +
    ' FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner WHERE p.oid = pg_catalog.to_regprocedure($2)) f' +
    // An unadmitted version calls the function with no tenants: no stamp is
    // read under a definition this reader has not checked.
    ' LEFT JOIN LATERAL ' + quote(namespace) + '.tenant_change_stamps(CASE WHEN f.version = $3 THEN $1::uuid[] ELSE \'{}\'::uuid[] END) s ON true';
  const inspect = 'SELECT p.prosecdef, p.proconfig, l.lanname, pg_catalog.pg_get_function_result(p.oid) AS result, p.prosrc,' +
    ' r.rolcanlogin, r.rolsuper, r.rolbypassrls,' +
    ' (SELECT c.relowner = p.proowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $2 AND c.relname = \'tenant_write_clock\') AS owns_clock,' +
    ' EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault(\'f\', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = \'EXECUTE\') AS public_execute' +
    ' FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner JOIN pg_catalog.pg_language l ON l.oid = p.prolang WHERE p.oid = pg_catalog.to_regprocedure($1)';
  const expectedConfig = ['app.current_tenant_id=', 'search_path=' + clockNamespace + ', pg_catalog'];
  let admitted = null;
  const counters = { calls: 0, checks: 0, refusals: 0 };
  async function check (version) {
    counters.checks++;
    const row = (await connection.readOnly(inspect, [signature, clockNamespace])).rows[0];
    const config = (row?.proconfig || []).map(value => value.replace(/"/g, '')).sort();
    if (!row || row.prosecdef !== true || row.lanname !== 'plpgsql' || row.result !== RESULT || row.prosrc !== BODY ||
        row.rolcanlogin || row.rolsuper || row.rolbypassrls || row.owns_clock !== true || row.public_execute ||
        JSON.stringify(config) !== JSON.stringify(expectedConfig)) { counters.refusals++; throw refuse('CHANGE_STAMPS_FUNCTION_UNSAFE'); }
    admitted = version;
  }
  async function stamps (tenants) {
    const list = [...tenants];
    counters.calls++;
    let result = await connection.readOnly(call, [list, signature, admitted]);
    const version = result.rows[0]?.version;
    if (typeof version !== 'string') { admitted = null; counters.refusals++; throw refuse('CHANGE_STAMPS_FUNCTION_UNSAFE'); }
    if (version !== admitted) {
      admitted = null;
      await check(version);
      counters.calls++;
      result = await connection.readOnly(call, [list, signature, version]);
      if (result.rows[0]?.version !== version) { admitted = null; counters.refusals++; throw refuse('CHANGE_STAMPS_FUNCTION_UNSAFE'); }
    }
    const found = new Map(list.map(tenant => [tenant, null]));
    for (const row of result.rows) if (row.tenant !== null) found.set(row.tenant, row.stamp);
    return found;
  }
  return Object.freeze({ stamps, stats: () => Object.freeze({ ...counters }) });
}
// Provisioning statements for a deployment (run by its bootstrap as the
// database owner after the catalogue is applied).
function grants ({ namespace, clockNamespace, roles }) {
  if (!NAME.test(namespace || '') || !NAME.test(clockNamespace || '') || !Array.isArray(roles) || !roles.length || roles.some(role => !NAME.test(role))) {
    throw new TypeError('Change-stamp grants require namespaces and the realtime and evaluator roles');
  }
  const fn = quote(namespace) + '.tenant_change_stamps(uuid[])';
  return Object.freeze(['ALTER FUNCTION ' + fn + ' SET search_path = ' + quote(clockNamespace) + ', pg_catalog',
    ...roles.flatMap(role => ['GRANT USAGE ON SCHEMA ' + quote(namespace) + ' TO ' + quote(role),
      'GRANT SELECT ON ' + quote(namespace) + '.schema_migrations TO ' + quote(role),
      'GRANT EXECUTE ON FUNCTION ' + fn + ' TO ' + quote(role)])]);
}
module.exports = { create, grants, catalogue, RESULT };
