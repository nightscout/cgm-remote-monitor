'use strict';

// The tenant registry (decision tenant-registry), PostgreSQL adapter.
//
// Host lookup happens before a tenant is known, so it is read only through the
// narrow SECURITY DEFINER function `tenant_registry_lookup(host, kind)`, which
// maps one exact host to its tenant id and state and nothing else. The
// aggregate revision (`tenant_registry_revision()`) is the stage-1 change
// signal: one statement per refresh interval per process. Realtime and the
// evaluator enumerate active tenant ids, without hosts, through
// `tenant_registry_tenants(after, page)`. The functions follow decision
// change-stamp-definer-function: owned by the NOLOGIN catalogue owner,
// search_path pinned by provisioning, EXECUTE revoked from PUBLIC and granted
// only to the identities named below. Every call carries the functions'
// catalogue version; a version this reader has not admitted runs the full
// attribute check before any row is used.
//
// Per-tenant attributes (signing version, public verification keys) live in
// tables under per-tenant RLS and are read with that tenant bound
// (connection.scanTenants), never through a definer function.
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const quote = name => '"' + name + '"';
const refuse = code => Object.assign(new Error(code), { code });
const catalogue = require('./postgres-candidate.json');
const created = prefix => catalogue.migrations.flatMap(migration => migration.up).filter(sql => sql.startsWith('CREATE FUNCTION ' + prefix + '(')).at(-1);
const body = sql => /AS \$fn\$(.*)\$fn\$$/s.exec(sql)[1];
// signature -> { result, body, volatile config }
const FUNCTIONS = Object.freeze({
  tenant_registry_lookup: { signature: 'tenant_registry_lookup(text, text)', result: 'TABLE(tenant_id uuid, state text)', body: body(created('tenant_registry_lookup')), binds: true },
  tenant_registry_revision: { signature: 'tenant_registry_revision()', result: 'bigint', body: body(created('tenant_registry_revision')), binds: false },
  tenant_registry_tenants: { signature: 'tenant_registry_tenants(uuid, integer)', result: 'TABLE(tenant_id uuid)', body: body(created('tenant_registry_tenants')), binds: true }
});
const TOUCH = body(created('tenant_registry_touch'));
const KINDS = Object.freeze(['alias', 'internal']);
const MAX_PAGE = 10000;

function checkName (name) {
  return NAME.test(name || '') && name !== 'public' && name !== 'information_schema' && !name.startsWith('pg_');
}

function create ({ connection, namespace }) {
  if (typeof connection?.readOnly !== 'function' || typeof connection.scanTenants !== 'function' || !checkName(namespace)) {
    throw new TypeError('Tenant registry reader requires a connection and the registry namespace');
  }
  const ns = quote(namespace);
  const signatures = Object.values(FUNCTIONS).map(fn => namespace + '.' + fn.signature);
  // One version string for all three functions: the pg_proc row version and the
  // owner's attributes. A missing function yields a NULL version (refused).
  const VERSION = '(SELECT CASE WHEN count(*) = 3 THEN string_agg(p.xmin::text || \':\' || r.rolcanlogin::text || r.rolsuper::text || r.rolbypassrls::text, \',\' ORDER BY p.oid) END' +
    ' FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner WHERE p.oid IN (pg_catalog.to_regprocedure($1), pg_catalog.to_regprocedure($2), pg_catalog.to_regprocedure($3)))';
  const versionValues = signatures.slice();
  // An unadmitted version calls each function with inputs that read nothing.
  const LOOKUP = 'SELECT f.version, l.tenant_id::text AS tenant, l.state FROM (SELECT ' + VERSION + ' AS version) f' +
    ' LEFT JOIN LATERAL ' + ns + '.tenant_registry_lookup(CASE WHEN f.version = $4 THEN $5 ELSE \'\' END, $6) l ON true';
  const REVISION = 'SELECT f.version, CASE WHEN f.version = $4 THEN ' + ns + '.tenant_registry_revision()::text END AS revision FROM (SELECT ' + VERSION + ' AS version) f';
  const PAGE = 'SELECT f.version, CASE WHEN f.version = $4 THEN ' + ns + '.tenant_registry_revision()::text END AS revision, t.tenant_id::text AS tenant FROM (SELECT ' + VERSION + ' AS version) f' +
    ' LEFT JOIN LATERAL ' + ns + '.tenant_registry_tenants(CASE WHEN f.version = $4 THEN $5::uuid ELSE \'ffffffff-ffff-ffff-ffff-ffffffffffff\'::uuid END, $6::integer) t ON true ORDER BY t.tenant_id';
  const INSPECT = 'SELECT p.proname AS name, p.prosecdef, p.proconfig, l.lanname,' +
    ' pg_catalog.pg_get_function_result(p.oid) AS result, p.prosrc, r.rolcanlogin, r.rolsuper, r.rolbypassrls, n.nspname,' +
    ' (SELECT bool_and(c.relowner = p.proowner) FROM pg_catalog.pg_class c WHERE c.relnamespace = p.pronamespace AND c.relname IN (\'tenant_registry\', \'tenant_registry_hosts\', \'tenant_registry_clock\')) AS owns_tables,' +
    ' EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault(\'f\', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = \'EXECUTE\') AS public_execute' +
    ' FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner JOIN pg_catalog.pg_language l ON l.oid = p.prolang JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace' +
    ' WHERE p.oid IN (pg_catalog.to_regprocedure($1), pg_catalog.to_regprocedure($2), pg_catalog.to_regprocedure($3))';
  const ENTRY = 'SELECT r.state, r.signing_version, COALESCE((SELECT json_agg(json_build_object(\'purpose\', k.purpose, \'kid\', k.kid, \'publicKey\', k.public_key) ORDER BY k.purpose, k.kid)' +
    ' FROM ' + ns + '.tenant_registry_keys k), \'[]\'::json) AS keys FROM ' + ns + '.tenant_registry r';
  let admitted = null;
  const counters = { lookups: 0, revisions: 0, pages: 0, entries: 0, checks: 0, refusals: 0 };
  const unsafe = () => { admitted = null; counters.refusals++; return refuse('TENANT_REGISTRY_FUNCTION_UNSAFE'); };
  async function check (version) {
    counters.checks++;
    const rows = (await connection.readOnly(INSPECT, versionValues)).rows;
    const expectedConfig = binds => (binds ? ['app.current_tenant_id='] : []).concat(['search_path=' + namespace + ', pg_catalog']).sort();
    if (rows.length !== 3) throw unsafe();
    for (const row of rows) {
      const expected = Object.hasOwn(FUNCTIONS, row.name) ? FUNCTIONS[row.name] : null;
      const config = (row.proconfig || []).map(value => value.replace(/"/g, '')).sort();
      if (!expected || row.nspname !== namespace || row.prosecdef !== true || row.lanname !== 'plpgsql' || row.result !== expected.result ||
          row.prosrc !== expected.body || row.rolcanlogin || row.rolsuper || row.rolbypassrls || row.owns_tables !== true || row.public_execute ||
          JSON.stringify(config) !== JSON.stringify(expectedConfig(expected.binds))) throw unsafe();
    }
    admitted = version;
  }
  // A function of another shape fails when the call is planned: refused.
  const SHAPE = new Set(['42703', '42804', '42P13', '42883']);
  // Any database error from a call runs the attribute check: an altered
  // function (another owner, invoker rights, another shape) usually fails before
  // its version can be compared, and is refused as unsafe, not passed through.
  async function call (text, extra) {
    try { return await connection.readOnly(text, [...versionValues, admitted, ...extra]); }
    catch (error) {
      if (SHAPE.has(error?.code)) throw unsafe();
      if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) {
        const previous = admitted;
        await check(null);
        admitted = previous;
      }
      throw error;
    }
  }
  // Run `text` under an admitted version: at most one attribute check per new version.
  async function admittedCall (text, extra) {
    let result = await call(text, extra);
    const version = result.rows[0]?.version;
    if (typeof version !== 'string' || !version) throw unsafe();
    if (version !== admitted) {
      admitted = null;
      await check(version);
      result = await call(text, extra);
      if (result.rows[0]?.version !== version) throw unsafe();
    }
    return result;
  }
  return Object.freeze({
    // One exact host of one kind -> { tenant, state } or null.
    async lookup (host, kind) {
      if (typeof host !== 'string' || !host || host.length > 259 || !KINDS.includes(kind)) throw new TypeError('Registry lookup requires a host and a kind');
      counters.lookups++;
      const result = await admittedCall(LOOKUP, [host, kind]);
      const rows = result.rows.filter(row => row.tenant !== null);
      if (rows.length > 1 || rows.some(row => !UUID.test(row.tenant) || !['active', 'removed'].includes(row.state))) throw unsafe();
      return rows.length ? Object.freeze({ tenant: rows[0].tenant, state: rows[0].state }) : null;
    },
    // The aggregate revision, a decimal string.
    async revision () {
      counters.revisions++;
      const revision = (await admittedCall(REVISION, [])).rows[0]?.revision;
      if (typeof revision !== 'string' || !/^[0-9]{1,19}$/.test(revision)) throw unsafe();
      return revision;
    },
    // One page of active tenant ids after `after` (exclusive), with the revision
    // read in the same statement.
    async page (after = null, size = 1000) {
      if ((after !== null && !UUID.test(after)) || !Number.isSafeInteger(size) || size < 1 || size > MAX_PAGE) throw new TypeError('Registry page requires a cursor and a bounded size');
      counters.pages++;
      const result = await admittedCall(PAGE, [after, size]);
      const revision = result.rows[0]?.revision;
      if (typeof revision !== 'string' || !/^[0-9]{1,19}$/.test(revision)) throw unsafe();
      const tenants = result.rows.filter(row => row.tenant !== null).map(row => row.tenant);
      if (tenants.length > size || tenants.some(tenant => !UUID.test(tenant))) throw unsafe();
      return Object.freeze({ revision, tenants: Object.freeze(tenants) });
    },
    // Every active tenant id, paged; restarts (bounded) when the revision moves
    // between pages so the set belongs to one revision.
    async enumerate ({ pageSize = 1000, maxRestarts = 3 } = {}) {
      for (let attempt = 0; attempt <= maxRestarts; attempt++) {
        const tenants = []; let revision = null, after = null, moved = false;
        for (;;) {
          const page = await this.page(after, pageSize);
          if (revision === null) revision = page.revision;
          else if (page.revision !== revision) { moved = true; break; }
          tenants.push(...page.tenants);
          if (page.tenants.length < pageSize) break;
          after = page.tenants.at(-1);
        }
        if (!moved) return Object.freeze({ revision, tenants: Object.freeze(tenants) });
      }
      throw refuse('TENANT_REGISTRY_ENUMERATION_UNSETTLED');
    },
    // Per-tenant attributes read under the tenant's own RLS binding.
    async entry (tenant) {
      if (typeof tenant !== 'string' || !UUID.test(tenant)) throw new TypeError('Registry entry requires a canonical tenant');
      counters.entries++;
      const rows = (await connection.scanTenants([tenant], ENTRY)).get(tenant) || [];
      if (rows.length > 1) throw unsafe();
      if (!rows.length) return null;
      const row = rows[0];
      if (!['active', 'removed'].includes(row.state) || !Number.isSafeInteger(row.signing_version) || row.signing_version < 1 || !Array.isArray(row.keys)) throw unsafe();
      return Object.freeze({ tenant, state: row.state, signingVersion: row.signing_version,
        keys: Object.freeze(row.keys.map(key => Object.freeze({ purpose: key.purpose, kid: key.kid, publicKey: key.publicKey }))) });
    },
    stats: () => Object.freeze({ ...counters })
  });
}

// Provisioning statements for a deployment, run as the database owner after the
// catalogue is applied and its objects are owned by the NOLOGIN catalogue owner.
//   resolvers    EXECUTE lookup and revision (roles that map a request's host)
//   enumerators  EXECUTE revision and the paged enumeration (realtime, evaluator)
//   readers      { access: [...], management: [...] } SELECT on tenant_registry and
//                tenant_registry_keys under RLS (per-tenant attributes)
//   provisioner  INSERT/UPDATE/DELETE on the registry tables (the admin role's
//                provisioning identity); no function grant
function grants ({ namespace, resolvers = [], enumerators = [], readers = [], provisioner } = {}) {
  const roles = [...resolvers, ...enumerators, ...readers, ...(provisioner ? [provisioner] : [])];
  if (!checkName(namespace) || !Array.isArray(resolvers) || !Array.isArray(enumerators) || !Array.isArray(readers) ||
      !roles.length || roles.some(role => !NAME.test(role))) {
    throw new TypeError('Tenant registry grants require the namespace and explicit roles');
  }
  const ns = quote(namespace), path = 'SET search_path = ' + ns + ', pg_catalog';
  const fn = name => ns + '.' + name;
  const statements = [
    'ALTER FUNCTION ' + fn('tenant_registry_lookup(text, text)') + ' ' + path,
    'ALTER FUNCTION ' + fn('tenant_registry_revision()') + ' ' + path,
    'ALTER FUNCTION ' + fn('tenant_registry_tenants(uuid, integer)') + ' ' + path,
    'ALTER FUNCTION ' + fn('tenant_registry_touch()') + ' ' + path
  ];
  for (const role of new Set(roles)) statements.push('GRANT USAGE ON SCHEMA ' + ns + ' TO ' + quote(role), 'GRANT SELECT ON ' + ns + '.schema_migrations TO ' + quote(role));
  for (const role of new Set([...resolvers, ...enumerators])) statements.push('GRANT EXECUTE ON FUNCTION ' + fn('tenant_registry_revision()') + ' TO ' + quote(role));
  for (const role of resolvers) statements.push('GRANT EXECUTE ON FUNCTION ' + fn('tenant_registry_lookup(text, text)') + ' TO ' + quote(role));
  for (const role of enumerators) statements.push('GRANT EXECUTE ON FUNCTION ' + fn('tenant_registry_tenants(uuid, integer)') + ' TO ' + quote(role));
  for (const role of readers) statements.push('GRANT SELECT ON ' + fn('tenant_registry') + ', ' + fn('tenant_registry_keys') + ' TO ' + quote(role));
  if (provisioner) {
    statements.push('GRANT SELECT, INSERT, UPDATE (state, signing_version, updated_at) ON ' + fn('tenant_registry') + ' TO ' + quote(provisioner),
      'GRANT SELECT, INSERT, DELETE ON ' + fn('tenant_registry_hosts') + ' TO ' + quote(provisioner),
      'GRANT SELECT, INSERT, DELETE ON ' + fn('tenant_registry_keys') + ' TO ' + quote(provisioner));
  }
  return Object.freeze(statements);
}

module.exports = { create, grants, catalogue, FUNCTIONS, TOUCH, KINDS, MAX_PAGE };
