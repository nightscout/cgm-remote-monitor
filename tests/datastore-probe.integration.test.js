'use strict';
// covers: lib/server/serve/datastore-probe.js, lib/server/serve/datastore-recovery.js, lib/storage/postgres-connection.js
// Decision datastore-loss-before-window-retirement on an owned, disposable
// PostgreSQL container that this suite restarts. No operation window, lifetime
// session or cohort: the plain connection probe alone must turn the process
// unavailable after a PostgreSQL restart and recover it, with tenant queries
// served again. The break-it case removes the probe from the serving check and
// shows the process staying "available" across the restart.
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), net = require('node:net'), path = require('node:path'), vm = require('node:vm');
const { execFileSync } = require('node:child_process'), { Client } = require('pg');
const connect = require('../lib/storage/postgres-connection');
const datastoreProbe = require('../lib/server/serve/datastore-probe');
const scope = require('../lib/storage/tenant-scope');
const { optInSuite } = require('./support/opt-in');
const IMAGE = 'postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';
const A = '11111111-1111-4111-8111-111111111111';
const SUPERVISOR = path.resolve(__dirname, '../lib/server/serve/datastore-recovery.js');
const PROBE_STEP = '          if (plain) await bounded(() => plain.probe());\n';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
// The supervisor as shipped, or with the plain probe removed from its serving check.
function supervisorModule (ablate) {
  if (!ablate) return require(SUPERVISOR);
  const source = fs.readFileSync(SUPERVISOR, 'utf8');
  assert.equal(source.split(PROBE_STEP).length, 2, 'ablation reaches the actual serving probe step');
  const output = { exports: {} }, local = require('node:module').createRequire(SUPERVISOR);
  vm.runInThisContext('(function(require,module,exports){' + source.replace(PROBE_STEP, '') + '\n})', { filename: SUPERVISOR })(local, output, output.exports);
  return output.exports;
}

optInSuite(process.env.NS_DATASTORE_RECOVERY_DOCKER_TEST === '1', 'NS_DATASTORE_RECOVERY_DOCKER_TEST=1')('datastore loss: plain connection probe without an operation window (owned PostgreSQL, restarted)', function () {
  this.timeout(240000);
  const container = 'ns-datastore-probe-' + crypto.randomBytes(6).toString('hex');
  let owned = false, adminURI, readerOptions, store, previousMode;
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
  const birth = () => admin(async client => (await client.query('SELECT extract(epoch from pg_postmaster_start_time())::text AS birth')).rows[0].birth);
  async function restart () { docker('restart', '--time', '10', container); await admin(client => client.query('SELECT 1')); }
  async function until (predicate, ms, label) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(50); }
    assert.fail('timed out: ' + label);
  }
  async function served () {
    for (let attempt = 0; attempt < 20; attempt++) {
      try { return (await store.withTenant(A, () => store.query('SELECT count(*)::int AS n FROM probe_data.readings'))).rows[0].n; }
      catch { await delay(100); }
    }
    return null;
  }
  // The availability target a health check reads, with one recording role context.
  function target () {
    const events = [];
    return { events, available: true,
      contexts: () => [{ invalidateAll: async () => { events.push('invalidateAll'); }, resume () { events.push('resume'); } }],
      datastoreUnavailable () { this.available = false; events.push('unavailable'); },
      datastoreRecovered (result) { this.available = true; events.push('recovered:' + result.restarted); } };
  }
  async function drill ({ ablate }) {
    const probe = datastoreProbe.create({ options: readerOptions, timeoutMs: 2000 });
    await probe.probe();
    const health = target(), exhausted = [];
    const instance = supervisorModule(ablate).create({ cohort: health, probe, intervalMs: 250, boundMs: 60000, baseDelayMs: 50, maxDelayMs: 500,
      attemptTimeoutMs: 3000, log: () => {}, exhausted: code => exhausted.push(code) });
    const before = await birth();
    assert.equal(await served(), 1, 'tenant served before the loss');
    instance.start();
    try {
      await restart();
      assert.notEqual(await birth(), before, 'the postmaster is a new one');
      await until(() => health.events.includes('unavailable'), 15000, 'health turns unavailable after the restart');
      await until(() => health.events.some(event => event.startsWith('recovered')), 30000, 'recovery');
      assert.deepEqual(health.events.slice(0, 4), ['unavailable', 'invalidateAll', 'recovered:true', 'resume']);
      assert.equal(health.available, true); assert.deepEqual(exhausted, []);
      assert.equal(await served(), 1, 'tenant served again after recovery');
      assert.equal(instance.state().state, 'serving');
      return health.events;
    } finally { await instance.close(); }
  }

  before(async function () {
    previousMode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const password = crypto.randomBytes(24).toString('hex'), port = await freePort();
    execFileSync('docker', ['run', '--name', container, '--label', 'nightscout.test=datastore-probe', '-d', '-p', '127.0.0.1:' + port + ':5432',
      '-e', 'POSTGRES_USER=bootstrap', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=probe_test', IMAGE], { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: 'pipe' });
    owned = true;
    adminURI = 'postgres://bootstrap:' + password + '@127.0.0.1:' + port + '/probe_test';
    const secret = crypto.randomBytes(24).toString('hex');
    await admin(async client => {
      await client.query("CREATE ROLE probe_reader LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + secret + "'");
      await client.query('CREATE SCHEMA probe_data');
      await client.query('CREATE TABLE probe_data.readings (tenant_id uuid NOT NULL, value int NOT NULL)');
      await client.query('ALTER TABLE probe_data.readings ENABLE ROW LEVEL SECURITY');
      await client.query("CREATE POLICY tenant_scope ON probe_data.readings USING (tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid)");
      await client.query('GRANT USAGE ON SCHEMA probe_data TO probe_reader');
      await client.query('GRANT SELECT ON probe_data.readings TO probe_reader');
      await client.query('INSERT INTO probe_data.readings VALUES ($1, 1)', [A]);
    });
    readerOptions = { host: '127.0.0.1', port, user: 'probe_reader', password: secret, database: 'probe_test', ssl: false };
    store = await connect({ connectionString: 'postgres://probe_reader:' + secret + '@127.0.0.1:' + port + '/probe_test', application_name: 'probe-store', max: 2, connectionTimeoutMillis: 2000 });
  });
  after(async function () {
    scope.setTenancyMode(previousMode);
    await store?.end().catch(() => {});
    if (owned) execFileSync('docker', ['rm', '-f', '-v', container], { stdio: 'pipe' });
  });

  it('turns unavailable after a PostgreSQL restart, drops cached tenant state once, recovers and serves tenants again', async function () {
    await drill({ ablate: false });
  });

  it('control: without the plain probe in the serving check the process stays available across the restart (red)', async function () {
    await assert.rejects(drill({ ablate: true }), error => error.code === 'ERR_ASSERTION' && /health turns unavailable after the restart/.test(error.message));
  });

  it('restored: the shipped supervisor turns unavailable and recovers again', async function () {
    await drill({ ablate: false });
  });
});
