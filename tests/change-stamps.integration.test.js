'use strict';

// Decision change-stamp-definer-function on actual PostgreSQL: the catalogue,
// the deployment grants, the reader's attribute check, and the refusals.
// Disposable roles and schemas; synthetic tenants only.
// covers: lib/change-stamps/postgres.js, lib/change-stamps/postgres-candidate.json
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const scope = require('../lib/storage/tenant-scope');
const connect = require('../lib/storage/postgres-connection');
const { run } = require('../lib/migrations/postgres');
const changeStamps = require('../lib/change-stamps/postgres');
const { optInSuite } = require('./support/opt-in');

optInSuite(!!process.env.NS_TEST_POSTGRES_ADMIN_URI && /test/i.test(new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI || 'postgres://x/none').pathname),
  'disposable NS_TEST_POSTGRES_ADMIN_URI (database name containing "test")')('change-stamp definer function (actual PostgreSQL)', function () {
  this.timeout(120000);
  const id = randomUUID().replace(/-/g, '').slice(0, 10);
  const clock = 'cs_clock_' + id, ns = 'cs_fn_' + id, owner = 'cs_owner_' + id;
  const roles = { realtime: 'cs_rt_' + id, evaluator: 'cs_ev_' + id, api: 'cs_api_' + id, intruder: 'cs_login_' + id };
  const tenants = [randomUUID(), randomUUID(), randomUUID()];
  const fn = '"' + ns + '".tenant_change_stamps(uuid[])';
  const urls = {}, connections = {};
  let admin, prior;
  before(async function () {
    prior = scope.getTenancyMode(); scope.setTenancyMode('multi');
    admin = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI }); await admin.connect();
    await admin.query(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    for (const [kind, role] of Object.entries(roles)) {
      const password = randomBytes(18).toString('hex');
      await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      const url = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); url.username = role; url.password = password; urls[kind] = url.toString();
    }
    for (const [namespace, catalogue] of [[clock, require('../migrations/candidates/postgres-write-clock-v1.json')], [ns, changeStamps.catalogue]]) {
      await admin.query(`CREATE SCHEMA "${namespace}"`);
      await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, namespace, catalogue });
      await admin.query(`ALTER SCHEMA "${namespace}" OWNER TO "${owner}"`);
    }
    // As deploy/multitenant/bootstrap.js does: catalogue objects belong to the NOLOGIN owner.
    await admin.query(`ALTER TABLE "${clock}".tenant_write_clock OWNER TO "${owner}"`);
    await admin.query(`ALTER FUNCTION ${fn} OWNER TO "${owner}"`);
    for (const sql of changeStamps.grants({ namespace: ns, clockNamespace: clock, roles: [roles.realtime, roles.evaluator] })) await admin.query(sql);
    await admin.query(`INSERT INTO "${clock}".tenant_write_clock VALUES ($1, 11), ($2, 22)`, tenants.slice(0, 2));
    for (const kind of ['realtime', 'evaluator', 'api']) connections[kind] = await connect({ connectionString: urls[kind], max: 1 });
  });
  after(async function () {
    for (const connection of Object.values(connections)) await connection.end().catch(() => {});
    if (admin) {
      for (const namespace of [ns, clock]) await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`).catch(() => {});
      for (const role of [...Object.values(roles), owner]) {
        await admin.query(`DROP OWNED BY "${role}"`).catch(() => {});
        await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
      }
      await admin.end();
    }
    scope.setTenancyMode(prior);
  });
  const reader = kind => changeStamps.create({ connection: connections[kind], namespace: ns, clockNamespace: clock });
  it('returns every requested tenant\'s stamp in one statement for realtime and evaluator; RLS on the clock is unchanged', async function () {
    for (const kind of ['realtime', 'evaluator']) {
      const stamps = await reader(kind).stamps(tenants);
      assert.deepEqual([...stamps], [[tenants[0], '11'], [tenants[1], '22'], [tenants[2], null]]);
    }
    const forced = (await admin.query('SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1)', [clock + '.tenant_write_clock'])).rows[0];
    assert.equal(forced.relforcerowsecurity, true);
  });
  it('CS_SERVING_REFUSED: an api (serving) identity and PUBLIC cannot execute it', async function () {
    await assert.rejects(reader('api').stamps(tenants), /permission denied/);
    const acl = (await admin.query(`SELECT has_function_privilege($1, to_regprocedure($2), 'EXECUTE') AS api,
      EXISTS (SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = to_regprocedure($2))) a WHERE a.grantee = 0) AS public`, [roles.api, ns + '.tenant_change_stamps(uuid[])'])).rows[0];
    assert.deepEqual(acl, { api: false, public: false });
  });
  it('CS_STAMPS_ONLY: returns exactly (tenant_id, last_stamp) and leaves no tenant binding behind', async function () {
    const client = new Client({ connectionString: urls.realtime }); await client.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const result = await client.query(`SELECT * FROM ${fn.replace('(uuid[])', '')}($1::uuid[])`, [tenants]);
      assert.deepEqual(result.fields.map(field => field.name), ['tenant_id', 'last_stamp']);
      assert.equal(result.rows.length, 2);
      const after = (await client.query("SELECT coalesce(current_setting('app.current_tenant_id', true), '') AS bound")).rows[0].bound;
      assert.equal(after, '', 'the function\'s per-tenant binding does not reach the caller');
      const direct = await client.query(`SELECT count(*)::int AS n FROM "${clock}".tenant_write_clock`).catch(error => error);
      assert.ok(direct instanceof Error, 'the realtime identity holds no direct SELECT on the clock in this lab');
      await client.query('ROLLBACK');
    } finally { await client.end(); }
  });
  // Each alteration leaves a function that would still answer (the new owner
  // can read the clock, the search_path still resolves it, the invoker may
  // select it), so only the reader's attribute check can refuse it.
  for (const [label, alter, restore] of [
    ['owner changed to a LOGIN role', [`GRANT USAGE ON SCHEMA "${clock}" TO "${roles.intruder}"`, `GRANT SELECT ON "${clock}".tenant_write_clock TO "${roles.intruder}"`, `ALTER FUNCTION ${fn} OWNER TO "${roles.intruder}"`],
      [`ALTER FUNCTION ${fn} OWNER TO "${owner}"`, `REVOKE ALL ON "${clock}".tenant_write_clock FROM "${roles.intruder}"`, `REVOKE USAGE ON SCHEMA "${clock}" FROM "${roles.intruder}"`]],
    ['search_path changed', [`ALTER FUNCTION ${fn} SET search_path = public, "${clock}", pg_catalog`], null],
    ['EXECUTE granted to PUBLIC', [`GRANT EXECUTE ON FUNCTION ${fn} TO PUBLIC`], [`REVOKE EXECUTE ON FUNCTION ${fn} FROM PUBLIC`]],
    ['SECURITY INVOKER', [`GRANT USAGE ON SCHEMA "${clock}" TO "${roles.realtime}"`, `GRANT SELECT ON "${clock}".tenant_write_clock TO "${roles.realtime}"`, `ALTER FUNCTION ${fn} SECURITY INVOKER`],
      [`ALTER FUNCTION ${fn} SECURITY DEFINER`, `REVOKE ALL ON "${clock}".tenant_write_clock FROM "${roles.realtime}"`, `REVOKE USAGE ON SCHEMA "${clock}" FROM "${roles.realtime}"`]]
  ]) it('CS_ALTERED_REFUSED: ' + label + ' is refused before any stamp is used; restored, it is admitted again', async function () {
    const stamps = reader('realtime');
    await stamps.stamps(tenants);
    for (const sql of alter) await admin.query(sql);
    try {
      await assert.rejects(stamps.stamps(tenants), { code: 'CHANGE_STAMPS_FUNCTION_UNSAFE' });
    } finally {
      if (restore) for (const sql of restore) await admin.query(sql);
      else for (const sql of changeStamps.grants({ namespace: ns, clockNamespace: clock, roles: [roles.realtime, roles.evaluator] })) await admin.query(sql);
    }
    assert.equal((await stamps.stamps(tenants)).get(tenants[0]), '11');
    assert.equal(stamps.stats().refusals, 1);
  });
  it('CS_BODY_REPLACED: a replaced body is refused', async function () {
    const stamps = reader('realtime'); await stamps.stamps(tenants);
    const original = (await admin.query('SELECT pg_get_functiondef(to_regprocedure($1)) AS def', [ns + '.tenant_change_stamps(uuid[])'])).rows[0].def;
    await admin.query(original.replace('WHERE c.tenant_id = t', 'WHERE c.tenant_id = t OR true'));
    try { await assert.rejects(stamps.stamps(tenants), { code: 'CHANGE_STAMPS_FUNCTION_UNSAFE' }); }
    finally { await admin.query(original); }
    assert.equal((await stamps.stamps(tenants)).size, 3);
  });
  it('CS_SCALE: one statement for 1,000 tenants', async function () {
    const many = Array.from({ length: 1000 }, () => randomUUID());
    await admin.query(`INSERT INTO "${clock}".tenant_write_clock SELECT unnest($1::uuid[]), 5`, [many]);
    const stamps = reader('realtime'); await stamps.stamps(many);
    const t0 = process.hrtime.bigint(); const found = await stamps.stamps(many); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal([...found.values()].filter(value => value === '5').length, 1000);
    assert.equal(stamps.stats().calls, 3, 'first poll: unadmitted call, check, real call; second poll: one call');
    assert.equal(stamps.stats().checks, 1, 'the attribute check runs once per admitted version');
    console.log('      CS_SCALE 1000 tenants, one call: ' + ms.toFixed(1) + ' ms wall');
  });
});
