'use strict';

// Decision trusted-worker-performance-boundary (clarified 2026-11-17) on actual
// PostgreSQL: the display settings reader screens role, write scope, migration
// ledgers and store objects when it opens and when its owner calls check()
// (readiness/recovery), never inside a tenant read. Synthetic roles, schemas
// and tenants only.
// covers: lib/tenant-settings/effective-postgres.js, lib/tenant-settings/presentation-reader.js
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { performance } = require('node:perf_hooks');
const { randomBytes, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const scope = require('../lib/storage/tenant-scope');
const { run } = require('../lib/migrations/postgres');
const SettingsClient = require('../lib/storage/postgres-settings-protocol').Client;
const { optInSuite } = require('./support/opt-in');

const SOURCE = path.resolve(__dirname, '../lib/tenant-settings/effective-postgres.js');
const ABLATIONS = {
  // Control B sensitivity: the screen put back into every tenant read.
  perRead: ['return connection.readOnlySnapshot(tenant, async ({ query }) => {', 'return connection.readOnlySnapshot(tenant, async ({ query }) => { await screen(query);'],
  // Control A sensitivity: the catalogue privilege scan removed from the screen.
  scope: ['await readinessCheck(query);', 'void readinessCheck;']
};
function reader (ablation) {
  if (!ablation) return require(SOURCE);
  const [from, to] = ABLATIONS[ablation], source = fs.readFileSync(SOURCE, 'utf8');
  assert(source.includes(from), 'ablation anchor present: ' + ablation);
  const loaded = new Module(SOURCE, module); loaded.filename = SOURCE; loaded.paths = Module._nodeModulePaths(path.dirname(SOURCE));
  loaded._compile(source.replace(from, to), SOURCE); return loaded.exports;
}
// Any statement of the integrity screen (role, write scope, ledgers, objects).
const SCREEN = /pg_roles|has_schema_privilege|to_regclass|relrowsecurity|ORDER BY name COLLATE/;
// The shared pool still observes its initial role/backend/datastore identity.
// P6 removes the full settings screen; P9 owns shared connection observations.
const BACKEND_IDENTITY = 'SELECT rolsuper, rolbypassrls,pg_backend_pid() AS pid,current_user AS role,' +
  '(SELECT extract(epoch from backend_start)::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS birth,' +
  'current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,' +
  'inet_server_addr()::text AS server_address,inet_server_port() AS server_port,extract(epoch from pg_postmaster_start_time())::text AS postmaster_birth FROM pg_roles WHERE rolname = current_user';
const settingsScreens = texts => texts.filter(text => SCREEN.test(text) && text !== BACKEND_IDENTITY);

optInSuite(!!process.env.NS_TEST_POSTGRES_ADMIN_URI, 'disposable NS_TEST_POSTGRES_ADMIN_URI')('settings screen at open and owner check (actual PostgreSQL)', function () {
  this.timeout(60000);
  const tag = randomBytes(5).toString('hex'), owner = 'sc_owner_' + tag, role = 'sc_reader_' + tag, password = randomBytes(18).toString('hex');
  const namespaces = { settings: 'sc_settings_' + tag, operatorPolicy: 'sc_policy_' + tag }, unrelated = 'sc_unrelated_' + tag;
  const tenant = randomUUID();
  let admin, previous, url, statements = [];
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
    // Every statement text the display pool sends, including BEGIN/COMMIT.
    SettingsClient.prototype.query = function (...args) { statements.push(typeof args[0] === 'string' ? args[0] : args[0]?.text); return originalQuery.apply(this, args); };
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
  const grants = {
    insert: [`GRANT INSERT ON "${unrelated}".synthetic TO "${role}"`, `REVOKE INSERT ON "${unrelated}".synthetic FROM "${role}"`],
    create: [`GRANT CREATE ON SCHEMA "${unrelated}" TO "${role}"`, `REVOKE CREATE ON SCHEMA "${unrelated}" FROM "${role}"`]
  };
  const outcome = promise => promise.then(() => 'served', error => error.message);
  const open = ablation => reader(ablation)({ connectionString: url.toString(), namespaces });
  async function counted (fn) { const before = statements.length; const value = await fn(); return { value, texts: statements.slice(before) }; }
  async function readsOf (settings, n) { const rows = []; for (let i = 0; i < n; i++) rows.push((await counted(() => settings.read(tenant))).texts); return rows; }

  it('SL_READS: the open screens once; no read sends a screen statement, including after 61 s', async function () {
    const built = await counted(() => open()), settings = built.value;
    const realNow = performance.now, realDate = Date.now;
    try {
      assert(built.texts.some(text => SCREEN.test(text)), 'opening screens');
      const warm = await readsOf(settings, 20);
      performance.now = () => realNow.call(performance) + 61000; Date.now = () => realDate() + 61000;
      const later = await readsOf(settings, 5);
      const all = [...warm, ...later], counts = [...new Set(all.map(texts => texts.length))];
      console.log('    SL_READS statements: open=' + built.texts.length + ' per-read=' + JSON.stringify(counts) + ' screen-statements-in-reads=' + all.flat().filter(text => SCREEN.test(text)).length);
      assert.equal(counts.length, 1, 'every read sends the same statements');
      assert(all.every(texts => !texts.some(text => SCREEN.test(text))), 'no catalogue screen statement in any read');
      assert.equal((await settings.read(tenant)).version, 1);
    } finally { performance.now = realNow; Date.now = realDate; await settings.close(); }
  });
  it('control B: a screen put back into the read is detected by the same counter', async function () {
    const settings = await open('perRead');
    try {
      const reads = await readsOf(settings, 3), screened = reads.flat().filter(text => SCREEN.test(text)).length;
      console.log('    control B ablation: screen statements in 3 reads=' + screened);
      assert(screened > 0); assert.throws(() => assert(reads.every(texts => !texts.some(text => SCREEN.test(text)))), { code: 'ERR_ASSERTION' });
    } finally { await settings.close(); }
  });

  it('API proof admission suppresses the full settings screen at open, check and failed-read reopen while reads fail closed', async function () {
    const binding = { connectionString: url.toString(), namespaces };
    const presentation = require('../lib/tenant-settings/presentation-reader')(binding, { platformVerified: true });
    const relation = '"' + namespaces.settings + '".tenant_settings';
    try {
      const opened = await counted(() => presentation.check());
      assert.equal(settingsScreens(opened.texts).length, 0, 'verified open has no full settings screen');
      assert(opened.texts.every(text => text === BACKEND_IDENTITY), 'opening sends only the shared foundational identity observation');
      const first = await counted(() => presentation.read(tenant));
      assert.equal(first.value.version, 1); assert.equal(settingsScreens(first.texts).length, 0);
      await q(`REVOKE SELECT ON ${relation} FROM "${role}"`);
      try {
        await assert.rejects(presentation.read(tenant), { code: 'SETTINGS_POLICY_UNAVAILABLE' });
        assert.equal(presentation.health().ready, false, 'failed settings cannot supply a presentation');
      } finally { await q(`GRANT SELECT ON ${relation} TO "${role}"`); }
      const reopened = await counted(() => presentation.read(tenant));
      assert.equal(reopened.value.version, 1); assert.equal(presentation.health().ready, true);
      assert.equal(settingsScreens(reopened.texts).length, 0, 'verified reopen has no full settings screen');
      const checked = await counted(() => presentation.check());
      assert.equal(checked.texts.length, 0, 'verified owner check sends no SQL');
      console.log('    API_SETTINGS full-screen statements: open=' + settingsScreens(opened.texts).length +
        ' first-read=' + settingsScreens(first.texts).length + ' reopen=' + settingsScreens(reopened.texts).length +
        ' check=' + settingsScreens(checked.texts).length + '; foundational-identity: open=' +
        opened.texts.filter(text => text === BACKEND_IDENTITY).length + ' reopen=' + reopened.texts.filter(text => text === BACKEND_IDENTITY).length);
    } finally { await q(`GRANT SELECT ON ${relation} TO "${role}"`).catch(() => {}); await presentation.close(); }
  });

  for (const [kind, [grant, revoke]] of Object.entries(grants)) {
    it('SL_UNSAFE_' + kind.toUpperCase() + ': a reader role granted ' + kind.toUpperCase() + ' refuses at open and at check(); health is not ready; revoked, both pass', async function () {
      const settings = await open();
      const presentation = require('../lib/tenant-settings/presentation-reader')({ connectionString: url.toString(), namespaces });
      try {
        await presentation.check(); assert.equal(presentation.health().ready, true, 'green before the grant');
        await q(grant);
        await assert.rejects(open(), unsafe, 'startup refuses');
        await assert.rejects(settings.check(), unsafe, 'the held capability check refuses');
        await assert.rejects(presentation.check(), unsafe);
        const health = presentation.health();
        console.log('    SL_UNSAFE_' + kind.toUpperCase() + ' red: ' + JSON.stringify(health));
        assert.equal(health.ready, false); assert.equal(health.state, 'unavailable');
        await q(revoke);
        await settings.check(); const fresh = await open(); await fresh.close();
        await presentation.check(); assert.equal(presentation.health().ready, true, 'restored green');
        console.log('    SL_UNSAFE_' + kind.toUpperCase() + ' restored: ' + JSON.stringify(presentation.health()));
      } finally { await q(revoke).catch(() => {}); await settings.close(); await presentation.close(); }
    });
  }
  it('control A: without the catalogue privilege scan, a granted INSERT is served', async function () {
    const [grant, revoke] = grants.insert;
    await q(grant);
    try {
      const red = await outcome(open('scope').then(settings => settings.close()));
      const intact = await outcome(open().then(settings => settings.close()));
      console.log('    control A outcomes: ablated=' + red + ' intact=' + intact);
      assert.equal(red, 'served'); assert.equal(intact, unsafe.message);
    } finally { await q(revoke); }
  });
});
