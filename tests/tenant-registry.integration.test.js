'use strict';

// Decision tenant-registry on actual PostgreSQL: the catalogue, the deployment
// grants, the definer functions' narrow results, per-tenant RLS on the
// attribute tables, the reader's attribute check and the revision signal.
// Disposable roles and schemas; synthetic tenants and hosts only.
// covers: lib/tenant-registry/postgres.js, lib/tenant-registry/postgres-candidate.json, lib/tenant-registry/rules.js
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const scope = require('../lib/storage/tenant-scope');
const connect = require('../lib/storage/postgres-connection');
const { run } = require('../lib/migrations/postgres');
const registry = require('../lib/tenant-registry/postgres');
const rules = require('../lib/tenant-registry/rules');
const { optInSuite } = require('./support/opt-in');

const ADMIN = process.env.NS_TEST_POSTGRES_ADMIN_URI;
optInSuite(!!ADMIN && /test/i.test(new URL(ADMIN || 'postgres://x/none').pathname),
  'disposable NS_TEST_POSTGRES_ADMIN_URI (database name containing "test")')('tenant registry (actual PostgreSQL)', function () {
  this.timeout(120000);
  const id = randomUUID().replace(/-/g, '').slice(0, 10);
  const ns = 'tr_reg_' + id, owner = 'tr_owner_' + id;
  const roles = { api: 'tr_api_' + id, realtime: 'tr_rt_' + id, provisioner: 'tr_prov_' + id, intruder: 'tr_login_' + id };
  const A = randomUUID(), B = randomUUID(), C = randomUUID();
  const key = () => randomBytes(32).toString('base64');
  const urls = {}, connections = {};
  let admin, prior;
  const q = (sql, values) => admin.query(sql, values);
  const grants = () => registry.grants({ namespace: ns, resolvers: [roles.api], enumerators: [roles.realtime], readers: [roles.api], provisioner: roles.provisioner });
  async function seed (tenant, hosts, state = 'active') {
    await q(`INSERT INTO "${ns}".tenant_registry (tenant_id, state, signing_version) VALUES ($1, $2, 1)`, [tenant, state]);
    for (const [host, kind] of hosts) await q(`INSERT INTO "${ns}".tenant_registry_hosts (host, tenant_id, kind) VALUES ($1, $2, $3)`, [host, tenant, kind]);
    await q(`INSERT INTO "${ns}".tenant_registry_keys (tenant_id, purpose, kid, public_key) VALUES ($1, 'access', 'key1', $2), ($1, 'management', 'management1', $3)`, [tenant, key(), key()]);
  }
  before(async function () {
    prior = scope.getTenancyMode(); scope.setTenancyMode('multi');
    admin = new Client({ connectionString: ADMIN }); await admin.connect();
    await q(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    for (const [kind, role] of Object.entries(roles)) {
      const password = randomBytes(18).toString('hex');
      await q(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      const url = new URL(ADMIN); url.username = role; url.password = password; urls[kind] = url.toString();
    }
    await q(`CREATE SCHEMA "${ns}"`);
    await run('up', { direct: true, connectionString: ADMIN, namespace: ns, catalogue: registry.catalogue });
    // As a deployment bootstrap does: catalogue objects belong to the NOLOGIN owner.
    await q(`ALTER SCHEMA "${ns}" OWNER TO "${owner}"`);
    for (const table of ['tenant_registry', 'tenant_registry_hosts', 'tenant_registry_keys', 'tenant_registry_clock']) await q(`ALTER TABLE "${ns}".${table} OWNER TO "${owner}"`);
    for (const fn of ['tenant_registry_lookup(text, text)', 'tenant_registry_revision()', 'tenant_registry_tenants(uuid, integer)', 'tenant_registry_touch()']) await q(`ALTER FUNCTION "${ns}".${fn} OWNER TO "${owner}"`);
    for (const sql of grants()) await q(sql);
    await seed(A, [['one.example.test', 'alias'], ['one-internal.svc.test', 'internal']]);
    await seed(B, [['two.example.test', 'alias']]);
    await seed(C, [['three.example.test', 'alias']], 'removed');
    for (const kind of ['api', 'realtime', 'intruder']) connections[kind] = await connect({ connectionString: urls[kind], max: 1 });
  });
  after(async function () {
    for (const connection of Object.values(connections)) await connection.end().catch(() => {});
    if (admin) {
      await q(`DROP SCHEMA IF EXISTS "${ns}" CASCADE`).catch(() => {});
      for (const role of [...Object.values(roles), owner]) {
        await q(`DROP OWNED BY "${role}"`).catch(() => {});
        await q(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
      }
      await admin.end();
    }
    scope.setTenancyMode(prior);
  });
  const reader = kind => registry.create({ connection: connections[kind], namespace: ns });

  it('TR_LOOKUP: one exact host of one kind maps to its tenant id and state; anything else maps to nothing', async function () {
    const r = reader('api');
    assert.deepEqual({ ...await r.lookup('one.example.test', 'alias') }, { tenant: A, state: 'active' });
    assert.deepEqual({ ...await r.lookup('one-internal.svc.test', 'internal') }, { tenant: A, state: 'active' });
    assert.equal(await r.lookup('one-internal.svc.test', 'alias'), null, 'kind is part of the key');
    assert.equal(await r.lookup('ONE.example.test', 'alias'), null, 'exact match only; callers normalise');
    assert.equal(await r.lookup('example.test', 'alias'), null, 'no suffix or prefix match');
    assert.deepEqual({ ...await r.lookup('three.example.test', 'alias') }, { tenant: C, state: 'removed' });
  });

  it('TR_DEFINER_NARROW: the definer functions return only the host mapping (two columns, at most one row) and active ids, and leave no binding behind', async function () {
    const client = new Client({ connectionString: urls.api }); await client.connect();
    const rt = new Client({ connectionString: urls.realtime }); await rt.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const hit = await client.query(`SELECT * FROM "${ns}".tenant_registry_lookup($1, 'alias')`, ['one.example.test']);
      assert.deepEqual(hit.fields.map(field => field.name), ['tenant_id', 'state']);
      assert.deepEqual(hit.rows, [{ tenant_id: A, state: 'active' }]);
      for (const probe of ['', '%', '*', 'two.example.test OR true', 'one.example.test.']) {
        const rows = (await client.query(`SELECT * FROM "${ns}".tenant_registry_lookup($1, 'alias')`, [probe]).catch(() => ({ rows: [] }))).rows;
        assert.deepEqual(rows, [], 'probe ' + JSON.stringify(probe) + ' maps to nothing');
      }
      const bound = (await client.query("SELECT coalesce(current_setting('app.current_tenant_id', true), '') AS bound")).rows[0].bound;
      assert.equal(bound, '', 'the function\'s tenant binding does not reach the caller');
      await client.query('ROLLBACK');
      const page = await rt.query(`SELECT * FROM "${ns}".tenant_registry_tenants(NULL, 100)`);
      assert.deepEqual(page.fields.map(field => field.name), ['tenant_id'], 'enumeration returns ids only, no hosts');
      assert.deepEqual(page.rows.map(row => row.tenant_id).sort(), [A, B].sort(), 'only active tenants');
    } finally { await client.end(); await rt.end(); }
  });

  it('TR_ISOLATION: with tenant A bound, a serving identity sees A\'s registry rows and no B rows; it holds no direct read of hosts or the clock', async function () {
    const client = new Client({ connectionString: urls.api }); await client.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [A]);
      const tenants = (await client.query(`SELECT tenant_id FROM "${ns}".tenant_registry`)).rows.map(row => row.tenant_id);
      const keys = (await client.query(`SELECT DISTINCT tenant_id FROM "${ns}".tenant_registry_keys`)).rows.map(row => row.tenant_id);
      assert.deepEqual(tenants, [A]); assert.deepEqual(keys, [A]);
      await client.query('ROLLBACK');
      await client.query('BEGIN READ ONLY');
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM "${ns}".tenant_registry`)).rows[0].n, 0, 'nothing without a binding');
      await client.query('ROLLBACK');
      for (const table of ['tenant_registry_hosts', 'tenant_registry_clock']) {
        await assert.rejects(client.query(`SELECT * FROM "${ns}".${table}`), /permission denied/, table);
      }
    } finally { await client.end(); }
    const entry = await reader('api').entry(A);
    assert.equal(entry.tenant, A); assert.equal(entry.signingVersion, 1);
    assert.deepEqual(entry.keys.map(row => row.purpose), ['access', 'management']);
  });

  it('TR_GRANTS: PUBLIC and an ungranted login cannot execute the functions; the resolver cannot enumerate', async function () {
    await assert.rejects(reader('intruder').lookup('one.example.test', 'alias'), /permission denied/);
    await assert.rejects(reader('api').page(null, 10), /permission denied/);
    const acl = (await q(`SELECT bool_or(EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)) AS public FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1`, [ns])).rows[0];
    assert.equal(acl.public, false);
  });

  it('TR_REVISION: every registry change moves the aggregate revision in the same transaction; a rolled-back change does not', async function () {
    const r = reader('realtime');
    const before = BigInt(await r.revision());
    const D = randomUUID();
    await q('BEGIN'); await seed(D, [['four.example.test', 'alias']]); await q('ROLLBACK');
    assert.equal(BigInt(await r.revision()), before);
    await seed(D, [['four.example.test', 'alias']]);
    const after = BigInt(await r.revision());
    assert.ok(after > before, 'moved by the committed change');
    await q(`DELETE FROM "${ns}".tenant_registry_hosts WHERE tenant_id = $1`, [D]);
    await q(`UPDATE "${ns}".tenant_registry SET state = 'removed' WHERE tenant_id = $1`, [D]);
    assert.ok(BigInt(await r.revision()) > after);
  });

  it('TR_ENUMERATE: pages of active ids in id order, one revision per enumeration', async function () {
    const many = Array.from({ length: 25 }, () => randomUUID());
    for (const [i, tenant] of many.entries()) await seed(tenant, [['bulk-' + i + '.example.test', 'alias']]);
    const r = reader('realtime');
    const all = await r.enumerate({ pageSize: 7 });
    assert.deepEqual([...all.tenants], [A, B, ...many].sort());
    assert.equal(all.revision, await r.revision());
    assert.ok(r.stats().pages >= 4);
  });

  // Each alteration leaves a function that still answers, so only the reader's
  // attribute check can refuse it (as for the change-stamp function).
  const lookupFn = () => `"${ns}".tenant_registry_lookup(text, text)`;
  for (const [label, alter, restore] of [
    ['owner changed to a LOGIN role', () => [`ALTER FUNCTION ${lookupFn()} OWNER TO "${roles.intruder}"`], () => [`ALTER FUNCTION ${lookupFn()} OWNER TO "${owner}"`]],
    ['search_path changed', () => [`ALTER FUNCTION ${lookupFn()} SET search_path = public, "${ns}", pg_catalog`], null],
    ['EXECUTE granted to PUBLIC', () => [`GRANT EXECUTE ON FUNCTION ${lookupFn()} TO PUBLIC`], () => [`REVOKE EXECUTE ON FUNCTION ${lookupFn()} FROM PUBLIC`]],
    ['SECURITY INVOKER', () => [`ALTER FUNCTION ${lookupFn()} SECURITY INVOKER`], () => [`ALTER FUNCTION ${lookupFn()} SECURITY DEFINER`]]
  ]) it('TR_ALTERED_REFUSED: ' + label + ' is refused before any row is used; restored, it is admitted again', async function () {
    const r = reader('api');
    await r.lookup('one.example.test', 'alias');
    for (const sql of alter()) await q(sql);
    try {
      await assert.rejects(r.lookup('one.example.test', 'alias'), { code: 'TENANT_REGISTRY_FUNCTION_UNSAFE' });
    } finally {
      if (restore) for (const sql of restore()) await q(sql);
      else for (const sql of grants()) await q(sql);
    }
    assert.equal((await r.lookup('one.example.test', 'alias')).tenant, A);
    assert.equal(r.stats().refusals, 1);
  });

  it('TR_BODY_REPLACED: a widened body is refused by the reader', async function () {
    const r = reader('api'); await r.lookup('one.example.test', 'alias');
    const original = (await q('SELECT pg_get_functiondef(to_regprocedure($1)) AS def', [ns + '.tenant_registry_lookup(text, text)'])).rows[0].def;
    await q(original.replace('WHERE h.host = lookup_host AND h.kind = lookup_kind', 'WHERE h.host = lookup_host OR true'));
    try { await assert.rejects(r.lookup('one.example.test', 'alias'), { code: 'TENANT_REGISTRY_FUNCTION_UNSAFE' }); }
    finally { await q(original); }
    assert.equal((await r.lookup('one.example.test', 'alias')).tenant, A);
  });

  it('TR_RULES: Vault key names and lock keys derive from the tenant id alone', function () {
    assert.equal(rules.vaultKey(A, 'data'), 'tenant-data-' + A);
    assert.notEqual(rules.vaultKey(A, 'signing'), rules.vaultKey(B, 'signing'));
    assert.throws(() => rules.vaultKey(A, 'root'));
    assert.throws(() => rules.vaultKey(rules.METADATA_TENANT, 'data'));
    const lock = BigInt(rules.lockKey(A));
    assert.ok(lock >= 1n && lock <= 9223372036854775807n);
    assert.equal(rules.lockKey(A), rules.lockKey(A));
    assert.notEqual(rules.lockKey(A), rules.lockKey(B));
  });
});
