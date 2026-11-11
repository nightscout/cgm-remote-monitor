'use strict';

// covers: lib/tenant-lifecycle/operation-window.js, lib/tenant-lifecycle/operation-window-epoch.js, lib/tenant-lifecycle/operation-window-readiness.js, lib/storage/postgres-connection.js

// The restore fence and the catalogue admission epoch on disposable PostgreSQL
// with the deployment plan's catalogue and grants (deploy/multitenant/config.js,
// applied as bootstrap.js applies them, without Vault). A real operation window
// (lifetime identity) and a real lower connection (api identity) run tenant
// transactions while a superuser session closes the window, holds the restore
// lock, or changes the catalogue the admission depends on. Decision
// cost-proportional-to-activity (item 3): the full catalogue admission is reused
// only while the database reports the same epoch inside the transaction.
// Synthetic tenants and data only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { Client, Pool } = require('pg');
const { run } = require('../lib/migrations/postgres');
const plan = require('../deploy/multitenant/config');
const windows = require('../lib/tenant-lifecycle/operation-window');
const connect = require('../lib/storage/postgres-connection');
const scope = require('../lib/storage/tenant-scope');
const readiness = require('../lib/server/serve/evaluator-consumer-readiness');
const { optInSuite } = require('./support/opt-in');

// postgres:16, pinned by digest. Override only with another digest.
const IMAGE = process.env.NS_OPERATION_WINDOW_PG_IMAGE || 'postgres@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97';
const { A, B } = plan;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

optInSuite(process.env.NS_OPERATION_WINDOW_DOCKER_TEST === '1',
  'NS_OPERATION_WINDOW_DOCKER_TEST=1')('operation-window fence and catalogue epoch (disposable PostgreSQL, deployment grants)', function () {
  this.timeout(120000);
  const container = (process.env.NS_OPERATION_WINDOW_PG_CONTAINER_PREFIX || 'ns-window-epoch-') + crypto.randomBytes(6).toString('hex');
  const l = plan.layout('nswep'), ns = l.namespaces, q = plan.quote;
  const control = name => q(ns.control) + '.' + q(name);
  const locks = [{ tenant: A, key: '830001' }, { tenant: B, key: '830002' }];
  const urls = {};
  let previousMode, owned = false, bootstrapURI, lifetimePool, window, lower, releaseWindow, suppression;

  async function asBootstrap (fn) {
    const client = new Client({ connectionString: bootstrapURI }); await client.connect();
    try { return await fn(client); } finally { await client.end(); }
  }
  const sql = text => asBootstrap(client => client.query(text));
  // One tenant data transaction (lower, api identity) and one serving operation
  // (lifetime identity) wrapping a data transaction. `called` proves the body ran.
  async function data (tenant) {
    let called = false;
    await lower.withTenant(tenant, async () => { await lower.query('SELECT 1 AS x'); called = true; });
    return called;
  }
  async function operation (tenant) {
    let called = false;
    await window.run(tenant, async () => { called = await data(tenant); });
    return called;
  }
  async function refused (fn, codes) {
    let ran = false;
    await assert.rejects(fn(() => { ran = true; }), error => codes.includes(error.code) || assert.fail('unexpected refusal ' + (error.code || error.message)));
    assert.equal(ran, false, 'body must not run');
  }
  const refuseData = (tenant, codes) => refused(mark => lower.withTenant(tenant, async () => { mark(); }), codes);
  const refuseOperation = (tenant, codes) => refused(mark => window.run(tenant, async () => { mark(); }), codes);

  before(async function () {
    previousMode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const password = crypto.randomBytes(24).toString('hex');
    execFileSync('docker', ['run', '--name', container, '--label', 'nightscout.test=operation-window-epoch', '-d', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_USER=bootstrap', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=nightscout_epoch_test', IMAGE],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    owned = true;
    spawn('sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 2; done; docker rm -f -v "$2" >/dev/null 2>&1', 'reaper', String(process.pid), container],
      { detached: true, stdio: 'ignore' }).unref();
    const port = docker(['port', container, '5432/tcp']).split(':').pop();
    bootstrapURI = 'postgres://bootstrap:' + password + '@127.0.0.1:' + port + '/nightscout_epoch_test';
    const deadline = Date.now() + 30000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'bootstrap']); await asBootstrap(async () => {}); ready = true; }
      catch { await sleep(200); }
    }
    assert.ok(ready, 'disposable PostgreSQL ready');
    await asBootstrap(async admin => {
      await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await admin.query('REVOKE CREATE ON DATABASE "nightscout_epoch_test" FROM PUBLIC');
      await admin.query('CREATE ROLE ' + q(l.owner) + ' NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION');
      for (const [kind, name] of Object.entries(l.roles)) {
        const secret = crypto.randomBytes(24).toString('hex');
        await admin.query('CREATE ROLE ' + q(name) + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + secret + "'");
        const url = new URL(bootstrapURI); url.username = name; url.password = secret; urls[kind] = url.toString();
      }
      for (const [kind, catalogue] of Object.entries(plan.catalogues())) {
        const namespace = ns[kind]; await admin.query('CREATE SCHEMA ' + q(namespace));
        await run('up', { direct: true, connectionString: bootstrapURI, namespace, catalogue, statementTimeoutMs: 10000 });
        for (const row of (await admin.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=$1', [namespace])).rows) {
          await admin.query('ALTER TABLE ' + q(namespace) + '.' + q(row.tablename) + ' OWNER TO ' + q(l.owner));
        }
        for (const row of (await admin.query('SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1', [namespace])).rows) {
          await admin.query('ALTER FUNCTION ' + q(namespace) + '.' + q(row.proname) + '() OWNER TO ' + q(l.owner));
        }
        await admin.query('ALTER SCHEMA ' + q(namespace) + ' OWNER TO ' + q(l.owner));
      }
      for (const statement of plan.grants(l)) await admin.query(statement);
      for (const row of locks) await admin.query('INSERT INTO ' + control('tenant_lifecycle_windows') + "(tenant_id,lock_key,phase,generation) VALUES($1,$2,'active',1)", [row.tenant, row.key]);
    });
    lifetimePool = new Pool({ connectionString: urls.lifetime_api, max: 2, options: '-c search_path=pg_catalog' });
    window = windows.create({ namespace: ns.control, locks, pool: lifetimePool });
    await window.ready();
    releaseWindow = connect.installOperationWindow(window);
    lower = await connect({ connectionString: urls.api, operationWindow: window, max: 2 });
    const reader = await connect({ connectionString: urls.suppression, operationWindow: window, max: 1 }), calls = [];
    const recorded = { ...reader, query: (text, values) => { calls.push(typeof text === 'string' ? text : text.text); return reader.query(text, values); } };
    suppression = { connection: reader, calls, guard: readiness.suppressionGuard(recorded, ns.alarm, { operationWindow: window }) };
  });

  after(async function () {
    try {
      if (lower) await lower.end();
      if (suppression) await suppression.connection.end();
      if (releaseWindow) releaseWindow();
      if (window) await window.close();
      if (lifetimePool) await lifetimePool.end();
    } finally {
      scope.setTenancyMode(previousMode);
      if (owned) docker(['rm', '-f', '-v', container]);
    }
  });

  it('admits data transactions and operations of an active tenant', async function () {
    assert.equal(await data(A), true);
    assert.equal(await operation(A), true);
    assert.equal(await operation(B), true);
  });

  it('refuses a tenant whose window was closed after its admission was cached; the other tenant continues', async function () {
    assert.equal(await operation(A), true, 'cached admission');
    await sql('UPDATE ' + control('tenant_lifecycle_windows') + " SET phase='suspended',generation=generation+1,claim_id='" + crypto.randomUUID() +
      "',artifact_digest='" + 'a'.repeat(64) + "' WHERE tenant_id='" + A + "'");
    try {
      await refuseData(A, ['LIFECYCLE_WINDOW_SUSPENDED']);
      await refuseOperation(A, ['LIFECYCLE_WINDOW_SUSPENDED']);
      assert.equal(await operation(B), true);
    } finally {
      await sql('UPDATE ' + control('tenant_lifecycle_windows') + " SET phase='active',claim_id=NULL,artifact_digest=NULL WHERE tenant_id='" + A + "'");
    }
    assert.equal(await operation(A), true, 'reopened window admits again');
  });

  it('refuses while the restore holds the tenant lock exclusively', async function () {
    const holder = new Client({ connectionString: bootstrapURI }); await holder.connect();
    try {
      assert.equal((await holder.query('SELECT pg_try_advisory_lock($1::bigint) AS held', [locks[0].key])).rows[0].held, true);
      await refuseData(A, ['LIFECYCLE_WINDOW_SUSPENDED']);
      await refuseOperation(A, ['LIFECYCLE_WINDOW_SUSPENDED']);
      assert.equal(await data(B), true);
    } finally { await holder.end(); }
    assert.equal(await data(A), true);
  });

  // Each change makes the full admission refuse. After a cached admission, the
  // next transaction must see the new epoch, re-admit and refuse; after the
  // revert it must re-admit and succeed. `path` is the identity that the change
  // affects: lower (api), lifetime (the operation's own identity) or both.
  // A dropped column is permanent (the admission refuses dropped attributes), so
  // no case adds and drops one.
  const birth = () => control('tenant_lifecycle_backend_birth') + '()';
  const drift = [
    ['table UPDATE on windows', 'lower', who => 'GRANT UPDATE ON ' + control('tenant_lifecycle_windows') + ' TO ' + who, who => 'REVOKE UPDATE ON ' + control('tenant_lifecycle_windows') + ' FROM ' + who],
    ['column UPDATE(phase) on windows', 'lower', who => 'GRANT UPDATE (phase) ON ' + control('tenant_lifecycle_windows') + ' TO ' + who, who => 'REVOKE UPDATE (phase) ON ' + control('tenant_lifecycle_windows') + ' FROM ' + who],
    ['row security no longer forced', 'both', () => 'ALTER TABLE ' + control('tenant_lifecycle_windows') + ' NO FORCE ROW LEVEL SECURITY', () => 'ALTER TABLE ' + control('tenant_lifecycle_windows') + ' FORCE ROW LEVEL SECURITY'],
    ['an added policy', 'both', () => 'CREATE POLICY epoch_extra ON ' + control('tenant_lifecycle_operations') + ' FOR SELECT USING (true)', () => 'DROP POLICY epoch_extra ON ' + control('tenant_lifecycle_operations')],
    ['an added trigger', 'both', () => ['CREATE FUNCTION public.epoch_noop() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$',
      'CREATE TRIGGER epoch_noop BEFORE INSERT ON ' + control('tenant_lifecycle_operations') + ' FOR EACH ROW EXECUTE FUNCTION public.epoch_noop()'],
    () => ['DROP TRIGGER epoch_noop ON ' + control('tenant_lifecycle_operations'), 'DROP FUNCTION public.epoch_noop()']],
    ['an added index', 'both', () => 'CREATE INDEX epoch_phase ON ' + control('tenant_lifecycle_windows') + ' (phase)', () => 'DROP INDEX ' + q(ns.control) + '.epoch_phase'],
    ['a changed column default', 'both', () => 'ALTER TABLE ' + control('tenant_lifecycle_operations') + ' ALTER COLUMN finished SET DEFAULT true', () => 'ALTER TABLE ' + control('tenant_lifecycle_operations') + ' ALTER COLUMN finished SET DEFAULT false'],
    ['a loginable owner', 'both', () => 'ALTER ROLE ' + q(l.owner) + ' LOGIN', () => 'ALTER ROLE ' + q(l.owner) + ' NOLOGIN'],
    ['CREATE on a schema', 'lower', who => 'GRANT CREATE ON SCHEMA public TO ' + who, who => 'REVOKE CREATE ON SCHEMA public FROM ' + who],
    ['CREATE on the database', 'lower', who => 'GRANT CREATE ON DATABASE "nightscout_epoch_test" TO ' + who, who => 'REVOKE CREATE ON DATABASE "nightscout_epoch_test" FROM ' + who],
    ['membership of an elevated role', 'lower', who => ['CREATE ROLE epoch_elevated NOLOGIN CREATEDB', 'GRANT epoch_elevated TO ' + who], who => ['REVOKE epoch_elevated FROM ' + who, 'DROP ROLE epoch_elevated']],
    ['an elevated serving role', 'lower', who => 'ALTER ROLE ' + who + ' CREATEDB', who => 'ALTER ROLE ' + who + ' NOCREATEDB'],
    ['a bypassrls serving role', 'lower', who => 'ALTER ROLE ' + who + ' BYPASSRLS', who => 'ALTER ROLE ' + who + ' NOBYPASSRLS'],
    ['a changed migration ledger', 'both', () => 'INSERT INTO ' + control('schema_migrations') + " (name,checksum) VALUES ('9999_epoch_synthetic','" + '0'.repeat(64) + "')", () => 'DELETE FROM ' + control('schema_migrations') + " WHERE name='9999_epoch_synthetic'"],
    ['helper EXECUTE for a lower role', 'lower', who => 'GRANT EXECUTE ON FUNCTION ' + birth() + ' TO ' + who, who => 'REVOKE EXECUTE ON FUNCTION ' + birth() + ' FROM ' + who],
    ['a changed helper configuration', 'lifetime', () => 'ALTER FUNCTION ' + birth() + ' SET search_path = pg_catalog, public', () => 'ALTER FUNCTION ' + birth() + ' SET search_path = pg_catalog'],
    ['a foreign table write for the lifetime identity', 'lifetime', who => 'GRANT INSERT ON ' + q(ns.entries) + '.entries TO ' + who, who => 'REVOKE INSERT ON ' + q(ns.entries) + '.entries FROM ' + who],
    ['a foreign column write for the lifetime identity', 'lifetime', who => 'GRANT UPDATE (anonymous_roles) ON ' + q(ns.authorization) + '.tenant_authorization_config TO ' + who,
      who => 'REVOKE UPDATE (anonymous_roles) ON ' + q(ns.authorization) + '.tenant_authorization_config FROM ' + who],
    // Not an input of the suppression reader's guard: suppressionToo false.
    ['a foreign function executable by the lifetime identity', 'lifetime', () => 'CREATE FUNCTION public.epoch_foreign() RETURNS int LANGUAGE sql AS $$SELECT 1$$', () => 'DROP FUNCTION public.epoch_foreign()'],
    ['a replaced windows table', 'both', () => ['ALTER TABLE ' + control('tenant_lifecycle_windows') + ' RENAME TO epoch_windows_saved',
      'CREATE TABLE ' + control('tenant_lifecycle_windows') + ' (LIKE ' + q(ns.control) + '.epoch_windows_saved INCLUDING ALL)',
      // Readable by the serving identities, as a swapped-in table would need to be;
      // only its new identity (oid) differs from the admitted one.
      'GRANT SELECT ON ' + control('tenant_lifecycle_windows') + ' TO ' + [l.roles.api, l.roles.lifetime_api, l.roles.suppression].map(q).join(',')],
    () => ['DROP TABLE ' + control('tenant_lifecycle_windows'), 'ALTER TABLE ' + q(ns.control) + '.epoch_windows_saved RENAME TO tenant_lifecycle_windows']]
  ];
  const statements = (value, who) => [].concat(value(who));
  const roleFor = path => q(path === 'lifetime' ? l.roles.lifetime_api : l.roles.api);
  for (const [label, path, change, revert] of drift) {
    it('re-admits and refuses after ' + label + ', and admits again after the revert', async function () {
      assert.equal(await operation(A), true, 'cached admission before the change');
      for (const text of statements(change, roleFor(path))) await sql(text);
      try {
        const codes = ['LIFECYCLE_WINDOW_SCHEMA_UNSAFE', 'LIFECYCLE_WINDOW_ROLE_UNSAFE'];
        if (path !== 'lifetime') await refuseData(A, codes);
        if (path !== 'lower') await refuseOperation(A, codes);
        if (path !== 'lifetime') await refuseData(B, codes);
      } finally { for (const text of statements(revert, roleFor(path))) await sql(text); }
      assert.equal(await operation(A), true, 'admitted again after the revert');
    });
  }

  // Decision admission-epoch-everywhere: the alarm-suppression reader's per-snapshot
  // guard (evaluator-consumer-readiness.js suppressionGuard) on the same epoch, as
  // the suppression identity. Each change targets that identity where it is
  // role-specific; each is refused on the next snapshot after a cached admission.
  const suppressionCases = [...drift.filter(([label]) => label !== 'a foreign function executable by the lifetime identity'),
    ['a foreign table read for the suppression identity', 'suppression', who => 'GRANT SELECT ON ' + q(ns.entries) + '.entries TO ' + who, who => 'REVOKE SELECT ON ' + q(ns.entries) + '.entries FROM ' + who],
    ['a changed suppression policy', 'suppression', () => 'CREATE POLICY epoch_extra ON ' + q(ns.alarm) + '.tenant_alarm_suppression FOR SELECT USING (true)', () => 'DROP POLICY epoch_extra ON ' + q(ns.alarm) + '.tenant_alarm_suppression'],
    ['a changed suppression ledger', 'suppression', () => 'INSERT INTO ' + q(ns.alarm) + ".schema_migrations (name,checksum) VALUES ('9999_epoch_synthetic','" + '0'.repeat(64) + "')", () => 'DELETE FROM ' + q(ns.alarm) + ".schema_migrations WHERE name='9999_epoch_synthetic'"]];
  const snapshot = () => scope.withTenant(A, () => suppression.connection.snapshotTransaction(() => suppression.guard()));
  const fullChecks = () => suppression.calls.filter(text => text.includes('evaluator-consumer-suppression-role')).length;
  it('suppression reader: an unchanged epoch skips the full check', async function () {
    await snapshot(); const before = fullChecks();
    await snapshot(); await snapshot();
    assert.equal(fullChecks(), before);
  });
  for (const [label, , change, revert] of suppressionCases) {
    it('suppression reader refuses the next snapshot after ' + label.replace('the lifetime identity', 'the suppression identity') + ', and admits again after the revert', async function () {
      await snapshot();
      const who = q(l.roles.suppression);
      for (const text of statements(change, who)) await sql(text);
      try {
        await assert.rejects(snapshot(), error => ['EVALUATOR_CONSUMER_READINESS_REFUSED', 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE', 'LIFECYCLE_WINDOW_ROLE_UNSAFE'].includes(error.code || error.message) ||
          assert.fail('unexpected refusal ' + (error.code || error.message)));
      } finally { for (const text of statements(revert, who)) await sql(text); }
      await snapshot();
    });
  }

  // Decision admission-epoch-everywhere: the census identity is read once per
  // pooled client and again on a reconnect to a different backend.
  it('re-reads the backend identity after a reconnect to a different backend', async function () {
    const before = connect.cohortBackends(window).map(row => row.pid);
    assert.equal(await data(A), true);
    const pids = (await asBootstrap(client => client.query("SELECT pid FROM pg_stat_activity WHERE usename=$1", [l.roles.api]))).rows.map(row => row.pid);
    assert.ok(pids.length >= 1);
    await asBootstrap(client => client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1', [l.roles.api]));
    await new Promise(resolve => setTimeout(resolve, 200));
    for (let i = 0; i < 3; i++) { try { if (await data(A)) break; } catch { /* the terminated client is discarded on its first use */ } }
    assert.equal(await data(A), true);
    const after = connect.cohortBackends(window).map(row => row.pid);
    const fresh = (await asBootstrap(client => client.query("SELECT pid FROM pg_stat_activity WHERE usename=$1", [l.roles.api]))).rows.map(row => row.pid);
    assert.ok(fresh.some(pid => !before.includes(pid) && after.includes(pid)), 'the new backend is in the census');
  });
});
