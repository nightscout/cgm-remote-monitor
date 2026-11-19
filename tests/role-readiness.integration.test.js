'use strict';

// covers: lib/server/serve/role-readiness.js (isolation, admit), lib/server/serve/role-health.js (/healthz/isolation), lib/cli/commands/healthcheck.js (--endpoint isolation)

// The forced row-level-security screen as a serving-role health check
// (decision platform-verification-removal, 2026-11-19 follow-up). The expected
// tables and policies come from the migration catalogue; the check is one
// catalogue query per login plus the login's own attributes. Synthetic roles
// and namespaces in a disposable PostgreSQL only.
const assert = require('node:assert/strict');
const http = require('node:http');
const { Client } = require('pg');
const { optInSuite } = require('./support/opt-in');
const readiness = require('../lib/server/serve/role-readiness');
const roleHealth = require('../lib/server/serve/role-health');
const healthcheck = require('../lib/cli/commands/healthcheck');

const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
const LIFECYCLE = require('../lib/tenant-lifecycle/postgres-candidate.json');

describe('role readiness: isolation expectations come from the migration catalogue', function () {
  it('replays FORCE / NO FORCE and CREATE POLICY in order, qualified by the ledger namespace', function () {
    const rows = readiness.isolationExpected('synthetic_ns', LIFECYCLE);
    const windows = rows.find(row => row.table === 'synthetic_ns.tenant_lifecycle_windows');
    // 0007 turns FORCE off and on again; the policies created before it stay expected.
    assert.deepEqual(windows.policies, ['tenant_lifecycle_windows_provision', 'tenant_lifecycle_windows_read', 'tenant_restore_windows_update']);
    for (const row of rows) assert.ok(row.policies.length, 'every forced table carries a policy: ' + row.table);
    const entries = readiness.isolationExpected('synthetic_entries', require('../migrations/candidates/postgres-entries-v1.json'));
    assert.deepEqual(entries.map(row => row.table).sort(), ['synthetic_entries.entries', 'synthetic_entries.tenant_insertion_ordinal']);
  });

  it('the CLI accepts --endpoint isolation', async function () {
    const err = []; const io = { env: {}, stdout: { write () {} }, stderr: { write: s => err.push(s) } };
    assert.ok(healthcheck.ENDPOINTS.includes('isolation'));
    assert.equal(roleHealth.PATHS['/healthz/isolation'], 'isolation');
    // Without a listener address it is a usage error that names serve.internal, not an unknown endpoint.
    assert.equal(await healthcheck.run(['--endpoint', 'isolation'], io), 64);
    assert.match(err.join(''), /needs serve\.internal/);
  });
});

optInSuite(uri, 'NS_TEST_POSTGRES_ADMIN_URI')('role readiness: /healthz/isolation on actual PostgreSQL', function () {
  this.timeout(60000);
  const suffix = String(process.pid);
  const namespace = 'v2_isolation_' + suffix, login = 'v2_serving_' + suffix, password = 'synthetic-' + suffix;
  let admin, config, server, url;
  const serving = () => { const u = new URL(uri); u.username = login; u.password = password; return u.toString(); };
  const probe = async () => {
    const out = [], err = [];
    const code = await healthcheck.run(['--endpoint', 'isolation', '--url', url], { env: {}, stdout: { write: s => out.push(s) }, stderr: { write: s => err.push(s) } });
    return { code, text: out.join('') + err.join('') };
  };
  const raw = () => new Promise((resolve, reject) => http.get(url, res => {
    let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
  }).on('error', reject));

  before(async function () {
    admin = new Client({ connectionString: uri }); await admin.connect();
    await require('../lib/migrations/postgres').run('up', { direct: true, connectionString: uri, namespace, catalogue: LIFECYCLE });
    await admin.query(`CREATE ROLE "${login}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${login}"; GRANT SELECT ON "${namespace}".schema_migrations TO "${login}"`);
    // vcpool: serving login = secrets login; its ledger = the lifecycle catalogue.
    config = { secretsConnectionString: serving(), activity: { connectionString: serving(), namespace } };
    const health = roleHealth.create({ configs: () => ({ vcpool: config }), ready: () => true });
    server = http.createServer(health);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = 'http://127.0.0.1:' + server.address().port + '/healthz/isolation';
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`).catch(() => {});
      await admin.query(`DROP OWNED BY "${login}"`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS "${login}"`).catch(() => {});
      await admin.end();
    }
  });

  it('a migrated namespace and a safe login are healthy, and the start check admits', async function () {
    await readiness.isolation(config, 'vcpool');
    await readiness.admit(config, 'vcpool');
    const answer = await probe();
    assert.equal(answer.code, 0, answer.text);
  });

  it('control: a tenant-data table with row-level security not forced fails with the typed code, and refuses start', async function () {
    const table = `"${namespace}".tenant_lifecycle_requests`;
    await admin.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
    try {
      const body = await raw();
      assert.deepEqual(body, { status: 503, body: { check: 'isolation', status: 'unavailable', code: 'PLATFORM_SERVING_IDENTITY_UNSAFE' } });
      assert.equal((await probe()).code, 1);
      await assert.rejects(readiness.admit(config, 'vcpool'), error => {
        assert.equal(error.code, 'PLATFORM_SERVING_IDENTITY_UNSAFE');
        assert.ok(readiness.keeps(error), 'terminal start refusal');
        assert.deepEqual(error.unsafe, [namespace + '.tenant_lifecycle_requests']);
        return true;
      });
    } finally { await admin.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`); }
    assert.equal((await probe()).code, 0, 'restored');
  });

  it('a missing expected policy fails', async function () {
    const table = `"${namespace}".tenant_lifecycle_ceremony`;
    const def = (await admin.query(`SELECT pg_get_expr(polqual, polrelid) AS q, pg_get_expr(polwithcheck, polrelid) AS c FROM pg_policy
      WHERE polname = 'tenant_lifecycle_ceremony_tenant'`)).rows[0];
    await admin.query(`DROP POLICY tenant_lifecycle_ceremony_tenant ON ${table}`);
    try {
      await assert.rejects(readiness.isolation(config, 'vcpool'), error =>
        error.code === 'PLATFORM_SERVING_IDENTITY_UNSAFE' && error.unsafe.includes(namespace + '.tenant_lifecycle_ceremony:tenant_lifecycle_ceremony_tenant'));
    } finally { await admin.query(`CREATE POLICY tenant_lifecycle_ceremony_tenant ON ${table} USING (${def.q}) WITH CHECK (${def.c})`); }
    await readiness.isolation(config, 'vcpool');
  });

  it('a login that can bypass row-level security fails the same check', async function () {
    await admin.query(`ALTER ROLE "${login}" BYPASSRLS`);
    try {
      const body = await raw();
      assert.equal(body.status, 503); assert.equal(body.body.code, 'PLATFORM_SERVING_IDENTITY_UNSAFE');
    } finally { await admin.query(`ALTER ROLE "${login}" NOBYPASSRLS`); }
    assert.equal((await probe()).code, 0);
  });
});
