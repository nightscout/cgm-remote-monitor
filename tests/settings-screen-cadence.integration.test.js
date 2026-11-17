'use strict';

// Decision trusted-worker-performance-boundary on actual PostgreSQL: the
// display settings reader screens role, write scope, migration ledgers and
// store objects when a physical backend is admitted and at a bounded cadence,
// not on every tenant read. A failed screen refuses until a later screen
// passes. Synthetic roles, schemas and tenants only.
// covers: lib/tenant-settings/effective-postgres.js
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { randomBytes, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const scope = require('../lib/storage/tenant-scope');
const { run } = require('../lib/migrations/postgres');
const SettingsClient = require('../lib/storage/postgres-settings-protocol').Client;
const { optInSuite } = require('./support/opt-in');

const SOURCE = path.resolve(__dirname, '../lib/tenant-settings/effective-postgres.js');
// Each ablation removes one part of the new screening schedule.
const ABLATIONS = {
  admission: ['if (ticket) { ticket.admitted = true; return; }', 'if (ticket) return;'],
  cadence: [' || ticket.at - passed.at >= screenIntervalMs', ''],
  failClosed: ['catch (error) { refusedThrough = issued; throw error; }', 'catch (error) { throw error; }']
};
function reader (ablation) {
  if (!ablation) return require(SOURCE);
  const [from, to] = ABLATIONS[ablation], source = fs.readFileSync(SOURCE, 'utf8');
  assert(source.includes(from), 'ablation anchor present: ' + ablation);
  const loaded = new Module(SOURCE, module); loaded.filename = SOURCE; loaded.paths = Module._nodeModulePaths(path.dirname(SOURCE));
  loaded._compile(source.replace(from, to), SOURCE); return loaded.exports;
}

optInSuite(!!process.env.NS_TEST_POSTGRES_ADMIN_URI, 'disposable NS_TEST_POSTGRES_ADMIN_URI')('settings screen admission and cadence (actual PostgreSQL)', function () {
  this.timeout(60000);
  const tag = randomBytes(5).toString('hex'), owner = 'sc_owner_' + tag, role = 'sc_reader_' + tag, password = randomBytes(18).toString('hex');
  const namespaces = { settings: 'sc_settings_' + tag, operatorPolicy: 'sc_policy_' + tag }, unrelated = 'sc_unrelated_' + tag;
  const tenant = randomUUID();
  let admin, previous, url, statements = 0;
  const originalQuery = SettingsClient.prototype.query;
  const q = (sql, values) => admin.query(sql, values);
  before(async function () {
    previous = scope.getTenancyMode(); scope.setTenancyMode('multi');
    admin = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI }); await admin.connect();
    await q(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await q(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    for (const [kind, catalogue] of [['settings', require('../lib/tenant-settings/postgres-candidate.json')], ['operatorPolicy', require('../lib/operator-policy/postgres-candidate.json')]]) {
      const namespace = namespaces[kind];
      await q(`CREATE SCHEMA "${namespace}"`);
      await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, namespace, catalogue });
      for (const row of (await q('SELECT tablename FROM pg_tables WHERE schemaname=$1', [namespace])).rows) await q(`ALTER TABLE "${namespace}"."${row.tablename}" OWNER TO "${owner}"`);
      for (const row of (await q('SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1', [namespace])).rows) await q(`ALTER FUNCTION ${row.fn} OWNER TO "${owner}"`);
      await q(`ALTER SCHEMA "${namespace}" OWNER TO "${owner}"`);
      await q(`GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"`);
      await q(`GRANT SELECT ON ALL TABLES IN SCHEMA "${namespace}" TO "${role}"`);
    }
    await q(`CREATE SCHEMA "${unrelated}"`); await q(`CREATE TABLE "${unrelated}".synthetic (id integer)`);
    await q(`INSERT INTO "${namespaces.settings}".tenant_settings (tenant_id,version,values) VALUES ($1,1,'{}'::jsonb)`, [tenant]);
    await q(`INSERT INTO "${namespaces.operatorPolicy}".tenant_operator_policy (tenant_id,generation,policy,principal,consumer,event_time) VALUES ($1,1,'{"deployment":{},"overrides":{}}'::jsonb,'synthetic','synthetic',0)`, [tenant]);
    url = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); url.username = role; url.password = password;
    // Every statement the display pool sends, including BEGIN/COMMIT.
    SettingsClient.prototype.query = function (...args) { statements++; return originalQuery.apply(this, args); };
  });
  after(async function () {
    SettingsClient.prototype.query = originalQuery;
    if (admin) {
      await q(`DROP SCHEMA IF EXISTS "${namespaces.settings}","${namespaces.operatorPolicy}","${unrelated}" CASCADE`).catch(() => {});
      for (const name of [role, owner]) { await q(`DROP OWNED BY "${name}"`).catch(() => {}); await q(`DROP ROLE IF EXISTS "${name}"`).catch(() => {}); }
      await admin.end();
    }
    scope.setTenancyMode(previous);
  });
  const unsafe = { message: 'unsafe settings scope' };
  const grant = () => q(`GRANT INSERT ON "${unrelated}".synthetic TO "${role}"`), revoke = () => q(`REVOKE INSERT ON "${unrelated}".synthetic FROM "${role}"`);
  const backends = async () => (await q('SELECT pid FROM pg_stat_activity WHERE usename=$1 ORDER BY pid', [role])).rows.map(row => row.pid);
  // Terminate actual reader backends, then let the pool observe the loss.
  async function terminate (pids) {
    for (const pid of pids || await backends()) await q('SELECT pg_terminate_backend($1)', [pid]);
    for (let n = 0; n < 100 && (await backends()).some(pid => (pids || [pid]).includes(pid)); n++) await new Promise(resolve => setTimeout(resolve, 20));
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  const outcome = promise => promise.then(() => 'served', error => error.message);
  async function open (ablation, clock) {
    return reader(ablation)({ connectionString: url.toString(), namespaces }, { now: () => clock.t });
  }
  async function counted (fn) { const before = statements; const value = await fn(); return { value, statements: statements - before }; }

  it('SC_WARM: one screen at construction, then warm reads on one backend send no screen statements until the interval ends', async function () {
    const clock = { t: 0 }; const built = await counted(() => open(undefined, clock)), settings = built.value;
    try {
      const reads = [];
      for (let i = 0; i < 20; i++) reads.push((await counted(() => settings.read(tenant))).statements);
      clock.t += 60000; const due = (await counted(() => settings.read(tenant))).statements;
      const after = (await counted(() => settings.read(tenant))).statements;
      console.log('    SC_WARM statements: construction=' + built.statements + ' warm=' + JSON.stringify([...new Set(reads)]) + ' due=' + due + ' next=' + after);
      assert.equal(new Set(reads).size, 1, 'every warm read sends the same statements');
      assert.equal(due - reads[0], 7, 'a due read adds the 7-statement screen');
      assert.equal(after, reads[0]);
      assert.equal((await settings.read(tenant)).version, 1);
    } finally { await settings.close(); }
  });

  // Each scenario returns what an intact implementation must refuse.
  async function admission (ablation) {
    const clock = { t: 0 }, settings = await open(ablation, clock);
    try {
      await settings.read(tenant); await grant();
      await settings.read(tenant); // warm backend inside the interval: not screened
      await terminate();
      return await outcome(settings.read(tenant));
    } finally { await settings.close().catch(() => {}); await revoke(); }
  }
  async function cadence (ablation) {
    const clock = { t: 0 }, settings = await open(ablation, clock);
    try {
      await settings.read(tenant); await grant(); clock.t += 59999;
      assert.equal((await settings.read(tenant)).version, 1, 'inside the bound the warm backend is not re-screened');
      clock.t += 1;
      return await outcome(settings.read(tenant));
    } finally { await settings.close().catch(() => {}); await revoke(); }
  }
  async function failClosed (ablation) {
    const clock = { t: 0 }, settings = await open(ablation, clock), outcomes = [];
    try {
      // Two admitted warm backends; replace one so a NEW backend fails its
      // admission screen while the other stays warm inside the interval.
      await Promise.all([settings.read(tenant), settings.read(tenant)]);
      const pids = await backends(); assert.equal(pids.length, 2, 'two reader backends');
      await grant(); await terminate([pids[0]]);
      const pair = await Promise.all([outcome(settings.read(tenant)), outcome(settings.read(tenant))]);
      assert(pair.includes(unsafe.message), 'the new backend refuses: ' + pair);
      outcomes.push(pair.sort().join('|'));
      outcomes.push(await outcome(settings.read(tenant)));
      await revoke();
      outcomes.push((await counted(() => settings.read(tenant))).statements);
      outcomes.push((await counted(() => settings.read(tenant))).statements);
      return outcomes;
    } finally { await settings.close().catch(() => {}); await revoke(); }
  }

  it('SC_ADMISSION: a new backend is screened before its first value read', async function () {
    assert.equal(await admission(), unsafe.message);
    const clock = { t: 0 }; await grant();
    try { await assert.rejects(open(undefined, clock), unsafe, 'a fresh reader refuses at pool construction'); } finally { await revoke(); }
  });
  it('SC_CADENCE: a change after admission is caught on the warm backend when the interval ends', async function () {
    assert.equal(await cadence(), unsafe.message);
  });
  it('SC_FAIL_CLOSED: a failed screen refuses later reads until a passing screen, then warm reads resume', async function () {
    const [, refused, recovered, warm] = await failClosed();
    assert.equal(refused, unsafe.message, 'a warm backend inside the interval is still refused after a failed screen');
    assert.equal(recovered - warm, 7, 'recovery read screened; the next read is warm');
  });
  it('control: each ablated part serves an unsafe store, and the intact source refuses', async function () {
    const red = { admission: await admission('admission'), cadence: await cadence('cadence'), failClosed: (await failClosed('failClosed'))[1] };
    console.log('    ablation outcomes: ' + JSON.stringify(red));
    assert.deepEqual(red, { admission: 'served', cadence: 'served', failClosed: 'served' });
    assert.equal(await admission(), unsafe.message); assert.equal(await cadence(), unsafe.message); assert.equal((await failClosed())[1], unsafe.message);
  });
});
