'use strict';
// covers: lib/server/serve/datastore-recovery.js, lib/tenant-lifecycle/operation-window.js, lib/tenant-lifecycle/lifetime-sessions.js, lib/storage/postgres-connection.js, lib/pool-membership/postgres.js
// Decision datastore-loss-recover-in-place on an owned, disposable PostgreSQL
// container that this suite restarts, stops and starts. Actual backends, the
// actual operation window, lifetime sessions, storage pool and supervisor; the
// role contexts are recording stand-ins (the Compose drill holds the role evidence).
const assert = require('node:assert/strict'), crypto = require('node:crypto'), net = require('node:net');
const { execFileSync } = require('node:child_process'), { Client, Pool } = require('pg');
const connect = require('../lib/storage/postgres-connection'), { run } = require('../lib/migrations/postgres');
const windows = require('../lib/tenant-lifecycle/operation-window');
const recovery = require('../lib/server/serve/datastore-recovery');
const rules = require('../lib/tenant-registry/rules');
const scope = require('../lib/storage/tenant-scope');
const { optInSuite } = require('./support/opt-in');
const IMAGE = 'postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';
const A = '11111111-1111-4111-8111-111111111111';
const METADATA = '00000000-0000-0000-0000-000000000000';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

optInSuite(process.env.NS_DATASTORE_RECOVERY_DOCKER_TEST === '1', 'NS_DATASTORE_RECOVERY_DOCKER_TEST=1')('datastore loss: recover in place (owned PostgreSQL, restarted)', function () {
  this.timeout(180000);
  const container = 'ns-datastore-recovery-' + crypto.randomBytes(6).toString('hex'), namespace = 'recovery_control';
  const q = name => '"' + name + '"';
  let owned = false, adminURI, lowerURI, lifetimeURI, pool, window, releaseWindow, store, poolErrors = 0, previousMode;
  const uncaught = [], onUncaught = error => uncaught.push(error);
  function docker (...args) { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim(); }
  async function admin (fn) {
    let client;
    for (let attempt = 0; attempt < 300; attempt++) {
      try { client = new Client({ connectionString: adminURI, connectionTimeoutMillis: 2000 }); client.on('error', () => {}); await client.connect(); break; }
      catch { await client?.end().catch(() => {}); client = null; await delay(100); }
    }
    assert(client, 'owned PostgreSQL reachable');
    try { return await fn(client); } finally { await client.end().catch(() => {}); }
  }
  const actualDatastore = () => admin(async client => connect.datastoreIdentity((await client.query('SELECT ' + connect.datastoreSQL)).rows[0]));
  const actualCluster = async () => {
    const client = await pool.connect(); let failure;
    try { return await require('../lib/storage/postgres-datastore').cluster(client); }
    catch (error) { failure = error; throw error; } finally { client.release(failure); }
  };
  const unfinished = () => admin(async client => Number((await client.query('SELECT count(*) AS n FROM ' + q(namespace) + '.tenant_lifecycle_operations WHERE NOT finished')).rows[0].n));
  async function restart () { docker('restart', '--time', '10', container); await admin(client => client.query('SELECT 1')); }
  // The recording cohort the supervisor drives; `available` is what a status call would answer.
  function cohort () {
    const events = [];
    return { events, available: true, window,
      contexts: () => [{ invalidateAll: async () => { events.push('invalidateAll'); } }],
      datastoreUnavailable () { this.available = false; events.push('unavailable'); },
      datastoreRecovered (result) { this.available = true; events.push('recovered:' + result.restarted + ':' + result.sessionsReplaced); } };
  }
  function supervisor (target, options = {}) {
    const exhausted = [];
    const instance = recovery.create({ cohort: target, intervalMs: 250, boundMs: 60000, baseDelayMs: 50, maxDelayMs: 500, log: () => {},
      exhausted: code => exhausted.push(code), ...options });
    return { instance, exhausted };
  }
  async function until (predicate, ms, label) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(50); }
    assert.fail('timed out: ' + label);
  }
  const operate = () => window.run(A, async () => (await store.withTenant(A, () => store.query('SELECT 1 AS one'))).rows[0].one);
  const refusal = async fn => { try { await fn(); return null; } catch (error) { return error.code || error.message; } };

  before(async function () {
    previousMode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const password = crypto.randomBytes(24).toString('hex'), port = await freePort();
    // A fixed loopback port: a random published port can change when the container restarts.
    execFileSync('docker', ['run', '--name', container, '--label', 'nightscout.test=datastore-recovery', '-d', '-p', '127.0.0.1:' + port + ':5432',
      '-e', 'POSTGRES_USER=bootstrap', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=recovery_test', IMAGE], { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: 'pipe' });
    owned = true;
    adminURI = 'postgres://bootstrap:' + password + '@127.0.0.1:' + port + '/recovery_test';
    // The image's initialization server has no TCP listener; the first TCP session is the service.
    await admin(async client => {
      await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC'); await client.query('REVOKE CREATE ON DATABASE recovery_test FROM PUBLIC');
      await client.query('CREATE ROLE recovery_owner NOLOGIN NOSUPERUSER NOBYPASSRLS');
      const urls = {};
      for (const role of ['recovery_lifetime', 'recovery_reader']) {
        const secret = crypto.randomBytes(24).toString('hex');
        await client.query('CREATE ROLE ' + q(role) + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + secret + "'");
        const url = new URL(adminURI); url.username = role; url.password = secret; urls[role] = url.toString();
      }
      lowerURI = urls.recovery_reader; lifetimeURI = urls.recovery_lifetime;
      await client.query('CREATE SCHEMA ' + q(namespace));
      await run('up', { direct: true, connectionString: adminURI, namespace, catalogue: require('../lib/tenant-lifecycle/postgres-candidate.json') });
      for (const row of (await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [namespace])).rows) await client.query('ALTER TABLE ' + q(namespace) + '.' + q(row.tablename) + ' OWNER TO recovery_owner');
      for (const row of (await client.query('SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1', [namespace])).rows) await client.query('ALTER FUNCTION ' + row.signature + ' OWNER TO recovery_owner');
      await client.query('ALTER SCHEMA ' + q(namespace) + ' OWNER TO recovery_owner');
      await client.query('GRANT USAGE ON SCHEMA ' + q(namespace) + ' TO recovery_lifetime, recovery_reader');
      for (const table of ['schema_migrations', 'tenant_lifecycle_windows', 'tenant_lifecycle_operations']) await client.query('GRANT SELECT ON ' + q(namespace) + '.' + q(table) + ' TO recovery_lifetime, recovery_reader');
      await client.query('GRANT INSERT(tenant_id,operation_id,generation),UPDATE(finished) ON ' + q(namespace) + '.tenant_lifecycle_operations TO recovery_lifetime');
      await client.query('GRANT EXECUTE ON FUNCTION ' + q(namespace) + '.tenant_lifecycle_backend_birth() TO recovery_lifetime');
      await client.query('INSERT INTO ' + q(namespace) + ".tenant_lifecycle_windows(tenant_id,lock_key,phase,generation) VALUES($1,$2,'active',1)", [A, rules.lockKey(A)]);
    });
    pool = new Pool({ connectionString: lifetimeURI, max: 4, connectionTimeoutMillis: 2000 });
    pool.on('error', () => { poolErrors++; });
    window = windows.create({ namespace, lockRule: 'tenant-id-sha256-v1', pool, leaseSessionCount: 2 });
    await window.ready(); releaseWindow = connect.installOperationWindow(window);
    store = await connect({ connectionString: lowerURI, application_name: 'recovery-lower', max: 2, connectionTimeoutMillis: 2000 });
    process.on('uncaughtException', onUncaught);
  });
  after(async function () {
    process.removeListener('uncaughtException', onUncaught);
    scope.setTenancyMode(previousMode);
    await store?.end().catch(() => {}); try { releaseWindow?.(); } catch { /* reported by the suite body */ }
    await window?.close().catch(() => {}); await pool?.end().catch(() => {});
    if (owned) execFileSync('docker', ['rm', '-f', '-v', container], { stdio: 'pipe' });
  });

  it('serves a tenant operation, and the probe passes, before any loss', async function () {
    assert.equal(await operate(), 1);
    await window.probe();
    assert.deepEqual((await connect.cohortSnapshot(window)).datastore, await actualDatastore());
  });

  it('reproduces the failure: after a PostgreSQL restart every operation is refused and the cohort still reports the old datastore', async function () {
    const before = window.datastore, cluster = await actualCluster();
    await restart();
    const actual = await actualDatastore();
    assert.notEqual(actual.postmaster_birth, before.postmaster_birth, 'the postmaster is a new one');
    assert.equal(await actualCluster(), cluster, 'same cluster under the actual narrow lifetime identity');
    assert.deepEqual([actual.database, actual.database_oid], [before.database, before.database_oid], 'same database; a recreated container may change its endpoint');
    const seen = new Set();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = await refusal(operate); assert.notEqual(code, null, 'an operation was served without re-admission'); seen.add(code);
      assert.equal(await refusal(() => store.withTenant(METADATA, () => store.query('SELECT 1'))), 'POSTGRES_COHORT_DATASTORE_CHANGED');
      await delay(200);
    }
    // 57P01 on a lifetime session that lost its backend; the datastore refusal on a new backend.
    for (const code of seen) assert.ok(['57P01', 'LIFECYCLE_WINDOW_DATASTORE_CHANGED', 'LIFECYCLE_WINDOW_SESSION_LOST'].includes(code), 'unexpected refusal ' + code);
    // What health read at J: a status built from the remembered identity, with no statement sent.
    const remembered = await connect.cohortSnapshot(window);
    assert.deepEqual(remembered.datastore, before); assert.deepEqual(window.datastore, before);
    assert.notDeepEqual(remembered.datastore, actual, 'the remembered identity is not the running datastore');
    await assert.rejects(window.probe(), error => ['LIFECYCLE_WINDOW_SESSION_LOST', 'LIFECYCLE_WINDOW_DATASTORE_CHANGED'].includes(error.code), 'the tenant-level probe tells the truth');
  });

  it('recovers in place: the supervisor re-admits the datastore, drops cached state once, and the same process serves again', async function () {
    const target = cohort(), { instance, exhausted } = supervisor(target);
    instance.start();
    try {
      await until(() => target.events.some(event => event.startsWith('recovered')), 30000, 'recovery');
      assert.deepEqual(target.events.slice(0, 2), ['unavailable', 'invalidateAll']);
      assert.equal(target.events.filter(event => event === 'invalidateAll').length, 1);
      assert.match(target.events.at(-1), /^recovered:true:[12]$/, 'postmaster restarted; lost lifetime sessions replaced');
      assert.equal(target.available, true); assert.deepEqual(exhausted, []);
      const actual = await actualDatastore();
      assert.deepEqual(window.datastore, actual);
      assert.equal(await operate(), 1);
      const snapshot = await connect.cohortSnapshot(window);
      assert.deepEqual(snapshot.datastore, actual);
      const births = await admin(async client => new Map((await client.query("SELECT pid, extract(epoch from backend_start)::text AS birth FROM pg_stat_activity WHERE usename='recovery_reader'")).rows.map(row => [row.pid, row.birth])));
      assert.ok(snapshot.backends.length >= 1);
      for (const backend of snapshot.backends) assert.equal(births.get(backend.pid), backend.birth, 'the census names only backends of the running postmaster');
      assert.equal(instance.state().state, 'serving');
    } finally { await instance.close(); }
  });

  it('recovers a lost lifetime session on the same postmaster without dropping cached state', async function () {
    assert.equal(await operate(), 1);
    const before = window.datastore;
    await admin(client => client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='recovery_lifetime'"));
    await delay(300);
    for (let attempt = 0; attempt < 5; attempt++) assert.notEqual(await refusal(operate), null, 'a lost lifetime session is not replaced by asking again');
    await assert.rejects(window.probe(), { code: 'LIFECYCLE_WINDOW_SESSION_LOST' });
    const target = cohort(), { instance } = supervisor(target);
    instance.start();
    try {
      await until(() => target.events.some(event => event.startsWith('recovered')), 30000, 'recovery');
      assert.deepEqual(target.events, ['unavailable', 'recovered:false:1']);
      assert.deepEqual(window.datastore, before);
      assert.equal(await operate(), 1);
    } finally { await instance.close(); }
  });

  it('refuses a lost control session and recovers without application participation markers', async function () {
    const before = await unfinished();
    let release, entered; const held = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const running = window.run(A, () => { entered(); return held; });
    running.catch(() => {});
    await started;
    assert.equal(await unfinished(), before, 'application work creates no durable markers');
    await admin(client => client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='recovery_lifetime'"));
    await delay(300); release();
    await assert.rejects(running);
    const target = cohort(), { instance } = supervisor(target);
    instance.start();
    try { await until(() => target.available && target.events.length > 0, 30000, 'recovery'); } finally { await instance.close(); }
    assert.equal(await operate(), 1);
    assert.equal(await unfinished(), before, 'recovery preserves the original durable records');
  });

  it('stays unavailable and backs off while PostgreSQL is down, then recovers when it returns', async function () {
    const target = cohort(), { instance, exhausted } = supervisor(target);
    docker('stop', '--time', '10', container);
    instance.start();
    try {
      await until(() => target.available === false, 10000, 'unavailable');
      await delay(2500);
      assert.equal(target.available, false);
      const down = instance.state();
      assert.ok(down.attempts >= 3 && down.attempts <= 60, 'bounded retries while down: ' + down.attempts);
      assert.deepEqual(exhausted, []);
      docker('start', container);
      await until(() => target.available === true, 60000, 'recovery after start');
      assert.equal(await operate(), 1);
      assert.match(target.events.at(-1), /^recovered:true:/);
    } finally { await instance.close(); }
  });

  it('gives up after the bound: the exhaustion handler runs once and the process stays unavailable', async function () {
    const target = cohort(), { instance, exhausted } = supervisor(target, { boundMs: 3000 });
    docker('stop', '--time', '10', container);
    const started = Date.now();
    instance.start();
    try {
      await until(() => exhausted.length > 0, 30000, 'exhaustion');
      assert.ok(Date.now() - started >= 3000, 'not before the bound');
      await delay(1500);
      assert.equal(exhausted.length, 1); assert.equal(target.available, false); assert.equal(instance.state().state, 'exhausted');
    } finally { await instance.close(); docker('start', container); await admin(client => client.query('SELECT 1')); }
    // The process was not replaced in this suite; bring it back for the next case.
    const again = cohort(), next = supervisor(again); next.instance.start();
    try { await until(() => again.available && again.events.length > 0, 60000, 'recovery'); } finally { await next.instance.close(); }
  });

  it('an idle backend lost by the pool-membership pool is logged, not an uncaught exception', async function () {
    const membership = require('../lib/pool-membership/postgres');
    assert.equal(typeof membership.connect, 'function', 'pool-membership exports its pool constructor for this check');
    const ns = 'recovery_membership';
    await admin(async client => {
      await client.query('CREATE SCHEMA ' + q(ns));
      await run('up', { direct: true, connectionString: adminURI, namespace: ns, catalogue: membership.catalogue });
      for (const statement of membership.grants({ namespace: ns, inspector: 'recovery_reader' })) await client.query(statement);
    });
    const errors = [], original = console.error; console.error = (...args) => errors.push(args.join(' '));
    let opened;
    try {
      opened = await membership.connect({ kind: 'evaluator', connectionString: lowerURI, namespace: ns, capability: 'inspector' });
      await opened.pool.query('SELECT 1');
      const seen = uncaught.length;
      await admin(client => client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='nightscout-pool-evaluator'"));
      await delay(500);
      assert.equal(uncaught.length, seen, 'no uncaught exception');
      assert.ok(errors.some(line => /pool-membership idle connection error: 57P01/.test(line)), 'the loss is logged with its code');
      assert.equal((await opened.pool.query('SELECT 1 AS one')).rows[0].one, 1, 'the pool opens a new backend');
    } finally { console.error = original; await opened?.pool.end().catch(() => {}); }
  });

  it('saw no uncaught exception across every loss in this suite', function () {
    assert.deepEqual(uncaught.map(error => error.code || error.message), []);
    assert.ok(poolErrors >= 1, 'the operation pool did lose idle backends (' + poolErrors + ')');
  });
});
