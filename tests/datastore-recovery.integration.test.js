'use strict';
// covers: lib/server/serve/datastore-recovery.js, lib/server/serve/datastore-probe.js, lib/storage/postgres-connection.js, lib/pool-membership/postgres.js
// Decision datastore-loss-recover-in-place on an owned, disposable PostgreSQL
// container that this suite restarts, stops and starts. Actual backends, the
// role connection probe, storage pool, supervisor and recorded role callbacks.
const assert = require('node:assert/strict'), crypto = require('node:crypto'), net = require('node:net');
const { execFileSync } = require('node:child_process'), { Client } = require('pg');
const connect = require('../lib/storage/postgres-connection'), { run } = require('../lib/migrations/postgres');
const datastoreProbe = require('../lib/server/serve/datastore-probe');
const recovery = require('../lib/server/serve/datastore-recovery');
const scope = require('../lib/storage/tenant-scope');
const { optInSuite } = require('./support/opt-in');
const IMAGE = 'postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';
const A = '11111111-1111-4111-8111-111111111111';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

optInSuite(process.env.NS_DATASTORE_RECOVERY_DOCKER_TEST === '1', 'NS_DATASTORE_RECOVERY_DOCKER_TEST=1')('datastore loss: recover in place (owned PostgreSQL, restarted)', function () {
  this.timeout(180000);
  const container = 'ns-datastore-recovery-' + crypto.randomBytes(6).toString('hex');
  let owned = false, adminURI, lowerURI, store, probe, previousMode;
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
  function availability () {
    const events = [];
    return { events, available: true,
      contexts: () => [{ invalidateAll: async () => { events.push('invalidateAll'); } }],
      datastoreUnavailable () { this.available = false; events.push('unavailable'); },
      datastoreRecovered (result) { this.available = true; events.push('recovered:' + result.restarted); } };
  }
  function supervisor (target, options = {}) {
    const exhausted = [];
    const instance = recovery.create({ target, probe, intervalMs: 250, boundMs: 60000, baseDelayMs: 50, maxDelayMs: 500, log: () => {},
      exhausted: code => exhausted.push(code), ...options });
    return { instance, exhausted };
  }
  async function until (predicate, ms, label) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(50); }
    assert.fail('timed out: ' + label);
  }
  const operate = async () => (await store.withTenant(A, () => store.query('SELECT 1 AS one'))).rows[0].one;

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
      const secret = crypto.randomBytes(24).toString('hex');
      await client.query("CREATE ROLE recovery_reader LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '" + secret + "'");
      const url = new URL(adminURI);
      url.username = 'recovery_reader'; url.password = secret; lowerURI = url.toString();
    });
    probe = datastoreProbe.create({ options: { connectionString: lowerURI } });
    await probe.probe();
    store = await connect({ connectionString: lowerURI, application_name: 'recovery-lower', max: 2, connectionTimeoutMillis: 2000 });
    process.on('uncaughtException', onUncaught);
  });
  after(async function () {
    process.removeListener('uncaughtException', onUncaught);
    scope.setTenancyMode(previousMode);
    await store?.end().catch(() => {});
    if (owned) {
      docker('rm', '-f', '-v', container);
      assert.equal(docker('ps', '-aq', '--filter', 'name=^/' + container + '$'), '', 'owned PostgreSQL removed');
    }
  });

  it('stays unavailable and backs off while PostgreSQL is down, then recovers when it returns', async function () {
    const target = availability(), { instance, exhausted } = supervisor(target);
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
      assert.match(target.events.at(-1), /^recovered:true$/);
    } finally { await instance.close(); }
  });

  it('gives up after the bound: the exhaustion handler runs once and the process stays unavailable', async function () {
    const target = availability(), { instance, exhausted } = supervisor(target, { boundMs: 3000 });
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
    const again = availability(), next = supervisor(again); next.instance.start();
    try { await until(() => again.available && again.events.length > 0, 60000, 'recovery'); } finally { await next.instance.close(); }
  });

  it('an idle backend lost by the pool-membership pool is logged, not an uncaught exception', async function () {
    const membership = require('../lib/pool-membership/postgres');
    assert.equal(typeof membership.connect, 'function', 'pool-membership exports its pool constructor for this check');
    const ns = 'recovery_membership';
    await admin(async client => {
      await client.query('CREATE SCHEMA ' + ns);
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
  });
});
