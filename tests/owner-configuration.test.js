'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const express = require('express');
const request = require('supertest');
const createResolver = require('../lib/tenant-resolution');
const ownerRouter = require('../lib/server/tenant-app/owner-settings');
const { createTenantSettings } = require('../lib/tenant-settings/component');
const environment = require('../lib/server/tenant-app/environment');
const presentation = require('../lib/server/tenant-app/presentation-environment');
const sharedContext = require('../lib/server/tenant-app/shared-rest-context');
const settingsConfig = require('../lib/server/serve/settings-config');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const actor = { tenant: A, principal: 'manager', consumer: 'owner-configuration' };
function routerFixture (authorized = true) {
  const state = { authorized, writes: 0, history: 0, calls: [], version: 1, values: {} };
  const store = { read: async () => ({ version: state.version, values: state.values }), history: async () => ({ values: {} }),
    write: async (_actor, expected, values) => {
      if (expected !== state.version) return undefined;
      state.writes++; state.history++; state.values = values; return { version: ++state.version, values };
    } };
  const service = createTenantSettings({ store, authorize: async who => {
    assert.deepEqual(who, actor); state.calls.push('configure'); return state.authorized;
  }, policyFor: async () => ({ deployment: {}, overrides: {}, generation: 1 }) });
  const app = express();
  app.use('/api/v1/tenant', ownerRouter({ resolver: createResolver({ aliases: [{ host: 'one.example.test', tenant: A }] }),
    authenticateManagement: async ({ credential }) => credential === 'synthetic-management' ? actor : null, tenantSettings: service }));
  const get = () => request(app).get('/api/v1/tenant/settings').set('Host', 'one.example.test').set('Authorization', 'Bearer synthetic-management');
  const put = body => request(app).put('/api/v1/tenant/settings').set('Host', 'one.example.test')
    .set('Authorization', 'Bearer synthetic-management').send(body);
  return { app, state, get, put };
}
function effective (units, seconds) {
  return { effective: { DISPLAY_UNITS: { value: units }, SHOW_SECONDS: { value: seconds } } };
}
function statusApp (env) {
  const tenant = '11111111-1111-4111-8111-111111111111';
  const context = sharedContext({ versionInfo: { name: 'synthetic', version: '1', storage: { storage: 'fixture', version: '1' } },
    admitted: { 1: [], 2: [], 3: [] } }).forContext({ tenant, env, collections: {}, statusAuthorization: async () => ({}) });
  const app = express(); app.use((req, res, next) => { req.tenantContext = { tenant }; req.tenantAuthenticate = async () => { const trie = require('shiro-trie').new(); trie.add('*'); require('../lib/api3/tenant-authentication').bind(req, { shiros: [trie] }); }; next(); }); app.use('/api/v1', context.legacy); return app;
}
function mutatedPresentation () {
  const file = path.resolve(__dirname, '../lib/server/tenant-app/presentation-environment.js');
  const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const source = fs.readFileSync(file, 'utf8'), needle = '  return local;';
  assert.equal(source.split(needle).length, 2);
  loaded._compile(source.replace(needle, '  return env;'), file); return loaded.exports;
}

describe('owner configuration serving source composition', function () {
  it('denies an authenticated GET without explicit configure, independently of writer fencing', async function () {
    const f = routerFixture(false); const response = await f.get();
    assert.equal(response.status, 403); assert.deepEqual(response.body, { error: 'SETTINGS_FORBIDDEN' });
    assert.equal(f.state.writes, 0); assert.deepEqual(f.state.calls, ['configure']);
  });
  it('GET authorization omission genuinely falsifies the denied-read oracle and restoration denies', async function () {
    const file = path.resolve(__dirname, '../lib/tenant-settings/component.js');
    const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
    const source = fs.readFileSync(file, 'utf8'), needle = "    if (await authorize(copy, { operation }) !== true) throw failure('SETTINGS_FORBIDDEN');";
    assert.equal(source.split(needle).length, 2);
    loaded._compile(source.replace(needle, "    if (operation !== 'read' && await authorize(copy, { operation }) !== true) throw failure('SETTINGS_FORBIDDEN');"), file);
    const options = { store: { read: async () => ({ version: 1, values: {} }), history () {}, write () {} },
      policyFor: async () => ({ deployment: {}, overrides: {}, generation: 1 }), authorize: async () => false };
    const deniedRead = service => assert.rejects(service.read(actor), { code: 'SETTINGS_FORBIDDEN' });
    assert.equal((await loaded.exports.createTenantSettings(options).read(actor)).version, 1);
    await assert.rejects(deniedRead(loaded.exports.createTenantSettings(options)), { code: 'ERR_ASSERTION' });
    await deniedRead(createTenantSettings(options));
  });
  it('serves the existing versioned contract, current revocation and strict bodies', async function () {
    const f = routerFixture(); assert.equal((await f.get()).status, 200);
    const good = await f.put({ expectedVersion: 1, values: { DISPLAY_UNITS: 'mmol', SHOW_SECONDS: true } });
    assert.equal(good.status, 200); assert.equal(good.body.version, 2); assert.equal(good.body.effective.DISPLAY_UNITS.value, 'mmol');
    assert.equal((await f.put({ expectedVersion: 1, values: {} })).status, 409);
    assert.equal((await f.put({ expectedVersion: 2, values: { TIMEZONE: 'UTC' } })).status, 400);
    assert.equal((await f.put({ expectedVersion: 2, values: null })).status, 400);
    assert.equal((await f.put({ expectedVersion: 2, values: {}, tenant: B })).status, 400);
    f.state.authorized = false; assert.equal((await f.get()).status, 403);
    assert.equal((await f.put({ expectedVersion: 2, values: {} })).status, 403);
    assert.equal(f.state.writes, 1); assert.equal(f.state.history, 1);
  });
  it('refuses wrong credentials, selectors and methods; dependencies sanitize to503', async function () {
    const f = routerFixture();
    assert.equal((await request(f.app).get('/api/v1/tenant/settings').set('Host', 'one.example.test')).status, 401);
    assert.equal((await request(f.app).get('/api/v1/tenant/settings').set('Host', 'unknown.example.test')).status, 404);
    assert.equal((await request(f.app).delete('/api/v1/tenant/settings').set('Host', 'one.example.test').set('Authorization', 'Bearer synthetic-management')).status, 405);
    const app = express(); app.use(ownerRouter({ resolver: { resolve: async () => A },
      authenticateManagement: async () => { throw new TypeError('synthetic private dependency diagnostic'); },
      tenantSettings: { read () {}, replace () {}, rollback () {} } }));
    const failure = await request(app).get('/settings').set('Authorization', 'Bearer synthetic-management');
    assert.equal(failure.status, 503); assert.deepEqual(failure.body, { error: 'AUTHORITY_UNAVAILABLE' });
  });
  it('does not read display configuration for raw uploads, exchange, or raw collection reads', async function () {
    const env = environment(); let reads = 0;
    const reader = { read: async () => { reads++; throw new Error('unavailable display policy'); } };
    for (const [method, resource] of [['POST', '/entries'], ['PUT', '/treatments'], ['DELETE', '/entries/id'],
      ['GET', '/entries.json'], ['GET', '/verifyauth'], ['GET', '/authorization/request/device']]) {
      assert.equal(await presentation.forRequest({ reader, tenant: A, env, request: { method, path: resource }, domains: ['entries'] }), env);
    }
    assert.equal(reads, 0);
    await assert.rejects(presentation.forRequest({ reader, tenant: A, env, request: { method: 'GET', path: '/status.json' }, domains: [] }), /unavailable display policy/);
    assert.equal(reads, 1);
  });
  it('actual status settings consume fresh values on each operation, preserving base and B', async function () {
    const base = environment(), b = environment(); let state = effective('mg/dl', false);
    const reader = { read: async () => structuredClone(state) };
    const options = { reader, tenant: A, env: base, request: { method: 'GET', path: '/status.json' }, domains: [] };
    const old = await presentation.forRequest(options); state = effective('mmol', true);
    const current = await presentation.forRequest(options);
    const response = await request(statusApp(current)).get('/api/v1/status.json');
    assert.equal(response.status, 200); assert.equal(response.body.settings.units, 'mmol'); assert.equal(response.body.settings.showSeconds, true);
    assert.equal(old.settings.units, 'mg/dl'); assert.equal(base.settings.units, 'mg/dl'); assert.equal(b.settings.showSeconds, false);
  });
  it('boot-environment reuse makes the independent actual status oracle red', async function () {
    const options = { reader: { read: async () => effective('mmol', true) }, tenant: A, env: environment(),
      request: { method: 'GET', path: '/status' }, domains: [] };
    const stale = await mutatedPresentation().forRequest(options);
    const response = await request(statusApp(stale)).get('/api/v1/status.json');
    assert.equal(response.body.settings.units, 'mg/dl');
    assert.throws(() => assert.equal(response.body.settings.units, 'mmol'), { code: 'ERR_ASSERTION' });
    const restored = await request(statusApp(await presentation.forRequest(options))).get('/api/v1/status.json');
    assert.equal(restored.body.settings.units, 'mmol');
  });
  it('held A/B operations retain immutable separate presentation environments', async function () {
    const base = environment(); let release;
    const held = new Promise(resolve => { release = resolve; });
    const reader = { read: async tenant => { if (tenant === A) { await held; return effective('mmol', true); } return effective('mg/dl', false); } };
    const options = { reader, env: base, request: { method: 'GET', path: '/summary' }, domains: [] };
    const aPromise = presentation.forRequest({ ...options, tenant: A });
    const b = await presentation.forRequest({ ...options, tenant: B }); release(); const a = await aPromise;
    assert.notEqual(a, b); assert.equal(a.settings.units, 'mmol'); assert.equal(b.settings.units, 'mg/dl');
    assert.equal(base.settings.units, 'mg/dl'); assert.equal(base.settings.showSeconds, false);
  });
  it('optional config stays absent by default and requires separate scoped identity', function () {
    const invalid = () => { throw new TypeError('invalid optional configuration'); };
    const address = user => ['postgres', '://', user, ':', crypto.randomBytes(12).toString('hex'), '@127.0.0.1:5432/settings_test'].join('');
    const original = address('data'), read = address('display');
    const prior = { namespaces: { entries: 'data_entries' }, connections: [original] };
    assert.equal(settingsConfig(undefined, {}, prior, { invalid }), undefined);
    const value = { connectionEnv: 'DISPLAY_CONNECTION', namespaces: { settings: 'tenant_config', operatorPolicy: 'operator_config' } };
    assert.equal(settingsConfig(value, { DISPLAY_CONNECTION: read }, prior, { invalid }).connectionString, read);
    assert.throws(() => settingsConfig(value, { DISPLAY_CONNECTION: original }, prior, { invalid }), TypeError);
    assert.throws(() => settingsConfig({ ...value, unexpected: true }, { DISPLAY_CONNECTION: read }, prior, { invalid }), TypeError);
    assert.throws(() => settingsConfig({ ...value, namespaces: { ...value.namespaces, settings: 'data_entries' } }, { DISPLAY_CONNECTION: read }, prior, { invalid }), TypeError);
  });
  it('actual owner boot selects settings only explicitly and closes every owned pool on success/failure', async function () {
    const file = path.resolve(__dirname, '../lib/server/serve/owner-preview.js');
    async function boot (selected, breakPolicy = false) {
      const seen = { checks: [], queries: [], resources: [], closed: [] };
      class Client {
        async connect () {}
        async end () {}
        async query (sql) {
          seen.queries.push(sql);
          if (sql.includes('rolsuper')) return { rows: [{ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false }] };
          return { rows: [{ creates: false, mutates: false }] };
        }
      }
      const resource = name => { seen.resources.push(name); return { close: async () => { seen.closed.push(name); } }; };
      const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
      const requireOriginal = loaded.require.bind(loaded);
      loaded.require = name => {
        if (name === 'pg') return { Client };
        if (name === '../../migrations/postgres') return { run: async (operation, input) => { seen.checks.push({ operation, namespace: input.namespace }); } };
        if (name === '../../tenant-authorization/access-postgres') return async () => ({ ...resource('access'), snapshot () {} });
        if (name === '../../subject-admin/postgres') return async () => resource('subjects');
        if (name === '../../subject-admin/component') return { createSubjectAdmin: () => ({ update () {}, remove () {} }) };
        if (name === './owner-preview-authentication') return () => async () => actor;
        if (name === '../../tenant-settings/readiness') return async () => {};
        if (name === '../../tenant-settings/postgres') return async () => ({ ...resource('settings'), read () {}, history () {}, write () {}, currentConfigurationAuthority () {} });
        if (name === '../../operator-policy/postgres-read') return async () => {
          if (breakPolicy) throw new Error('synthetic unavailable policy factory');
          return { ...resource('policy'), read () {} };
        };
        return requireOriginal(name);
      };
      loaded._compile(fs.readFileSync(file, 'utf8'), file);
      const config = { consumer: actor.consumer, resolver: { resolve: async () => A }, ownerPolicy: { catalogue: ['api:entries:read'] },
        verification: {}, namespaces: { authorization: 'authority', credentials: 'credentials', access: 'access' },
        accessConnectionString: 'synthetic-reader', writerConnectionString: 'synthetic-writer',
        ...(selected ? { ownerSettings: { connectionString: 'synthetic-settings', namespaces: { settings: 'settings', operatorPolicy: 'policy', authority: 'configure' } } } : {}) };
      if (breakPolicy) { await assert.rejects(loaded.exports.boot(config), /synthetic unavailable/); return seen; }
      const running = await loaded.exports.boot(config); await running.close(); await running.close(); return seen;
    }
    const scope = require('../lib/storage/tenant-scope'), previous = scope.getTenancyMode();
    try {
      const unselected = await boot(false); assert.deepEqual(unselected.resources, ['access', 'subjects']);
      assert.equal(unselected.checks.length, 3);
      const selected = await boot(true); assert.deepEqual(selected.resources, ['access', 'subjects', 'settings', 'policy']);
      assert.equal(selected.checks.length, 6); assert.ok(selected.checks.every(check => check.operation === 'check'));
      assert.deepEqual(selected.closed, ['policy', 'settings', 'subjects', 'access']);
      assert.ok(selected.queries.every(sql => !/^(?:CREATE|ALTER|INSERT|UPDATE|DELETE)\b/i.test(sql.trim())));
      const failed = await boot(true, true); assert.deepEqual(failed.closed, ['settings', 'subjects', 'access']);
    } finally { scope.setTenancyMode(previous); }
  });

  it('DATA display capability is lazy, retries unavailable initialization and refuses reads after close', async function () {
    let opens = 0, closes = 0;
    const file = path.resolve(__dirname, '../lib/tenant-settings/presentation-reader.js');
    const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
    const original = loaded.require.bind(loaded);
    loaded.require = name => name === './effective-postgres' ? async () => {
      if (++opens === 1) throw new Error('synthetic unavailable display role');
      return { read: async tenant => { assert.equal(tenant, A); return effective('mmol', true); }, close: async () => { closes++; } };
    } : original(name);
    loaded._compile(fs.readFileSync(file, 'utf8'), file);
    const lazy = loaded.exports({}); assert.equal(opens, 0, 'constructing boot resource must not connect/probe');
    await assert.rejects(lazy.read(A), { code: 'SETTINGS_POLICY_UNAVAILABLE' }); assert.equal(opens, 1);
    assert.equal((await lazy.read(A)).effective.SHOW_SECONDS.value, true); assert.equal(opens, 2);
    await lazy.close(); await lazy.close(); assert.equal(closes, 1);
    await assert.rejects(lazy.read(A), { code: 'SETTINGS_POLICY_UNAVAILABLE' }); assert.equal(opens, 2);
  });
  it('shutdown drains pending display initialization and closes the late pool before finishing', async function () {
    let releaseOpen, releaseClose, reads = 0, closes = 0, stopped = false;
    const file = path.resolve(__dirname, '../lib/tenant-settings/presentation-reader.js');
    const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
    const original = loaded.require.bind(loaded);
    loaded.require = name => name === './effective-postgres' ? () => new Promise(resolve => { releaseOpen = resolve; }) : original(name);
    loaded._compile(fs.readFileSync(file, 'utf8'), file);
    const lazy = loaded.exports({}); const refused = assert.rejects(lazy.read(A), { code: 'SETTINGS_POLICY_UNAVAILABLE' });
    await new Promise(resolve => setImmediate(resolve));
    const stopping = lazy.close().then(() => { stopped = true; });
    releaseOpen({ read: async () => { reads++; }, close: async () => { closes++; await new Promise(resolve => { releaseClose = resolve; }); } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false); assert.equal(closes, 1); assert.equal(reads, 0);
    releaseClose(); await stopping; await refused; assert.equal(stopped, true);
  });
  // Control: one tenant's failed read never closes the reader for every tenant.
  it('a failed display read refuses only that read; the shared capability stays open for the next tenant', async function () {
    let opens = 0, closes = 0, failing = A;
    const file = path.resolve(__dirname, '../lib/tenant-settings/presentation-reader.js');
    const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
    const original = loaded.require.bind(loaded);
    loaded.require = name => name === './effective-postgres' ? async () => {
      ++opens;
      return { read: async tenant => { if (tenant === failing) throw new Error('synthetic policy outage'); return effective('mmol', false); }, close: async () => { closes++; } };
    } : original(name);
    loaded._compile(fs.readFileSync(file, 'utf8'), file);
    const lazy = loaded.exports({});
    await assert.rejects(lazy.read(A), { code: 'SETTINGS_POLICY_UNAVAILABLE' }); assert.equal(closes, 0);
    assert.equal((await lazy.read(B)).effective.DISPLAY_UNITS.value, 'mmol'); assert.equal(opens, 1);
    failing = null; assert.equal((await lazy.read(A)).effective.DISPLAY_UNITS.value, 'mmol'); assert.equal(opens, 1);
    await lazy.close(); assert.equal(closes, 1);
  });

  it('omitting the initialization drain makes the late-pool shutdown oracle red and restoration closes it', async function () {
    const file = path.resolve(__dirname, '../lib/tenant-settings/presentation-reader.js');
    const source = fs.readFileSync(file, 'utf8'), needle = '        if (opening) await opening.catch(() => {});';
    assert.equal(source.split(needle).length, 2);
    async function observe (broken) {
      let release, closes = 0;
      const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
      const original = loaded.require.bind(loaded);
      loaded.require = name => name === './effective-postgres' ? () => new Promise(resolve => { release = resolve; }) : original(name);
      // Both initialization and active-read drains now protect late pool cleanup.
      const mutant = source.replace(needle, '').replace('await Promise.allSettled([...reads]);', '');
      loaded._compile(broken ? mutant : source, file);
      const lazy = loaded.exports({}); const refused = assert.rejects(lazy.read(A), { code: 'SETTINGS_POLICY_UNAVAILABLE' });
      await new Promise(resolve => setImmediate(resolve));
      const closing = lazy.close(); release({ read: async () => effective('mmol', true), close: async () => { closes++; } });
      await closing; await refused; return closes;
    }
    const missed = await observe(true); assert.equal(missed, 0, 'actual mutated wrapper leaks the modeled late pool');
    assert.throws(() => assert.equal(missed, 1, 'late pool must close before shutdown'), { code: 'ERR_ASSERTION' });
    assert.equal(await observe(false), 1);
  });

  it('lazy display reads screen once at open, outside any tenant, and each tenant snapshot sends only its value', async function () {
    const scope = require('../lib/storage/tenant-scope'), previous = scope.getTenancyMode();
    const file = path.resolve(__dirname, '../lib/tenant-settings/effective-postgres.js');
    const lazyFile = path.resolve(__dirname, '../lib/tenant-settings/presentation-reader.js');
    const source = fs.readFileSync(file, 'utf8');
    const options = { connectionString: 'synthetic-display', namespaces: { settings: 'settings', operatorPolicy: 'policy' } };
    function factory ({ wrongBinding = false, omitScreen = false, unsafe = false } = {}) {
      const observed = { snapshots: [], metadata: 0, values: 0, ended: 0, catalogues: [] };
      const connection = {
        async readOnly (sql, params) {
          assert.equal(scope.currentTenant(), undefined, 'the screen binds no tenant');
          if (sql.includes('FROM pg_roles')) return { rows: [{ rolsuper: unsafe, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false }] };
          if (sql.includes(' AS creates,')) return { rows: [{ creates: false, mutates: false }] };
          assert(sql.includes('FROM pg_class'), 'only screen statements run outside a snapshot');
          observed.metadata++;
          assert.deepEqual(params, [['"settings".tenant_settings', '"policy".tenant_operator_policy']]);
          return { rows: [0, 1].map(() => ({ secured: true, owns: false, reads: true, writes: false })) };
        },
        readOnlySnapshot (tenant, fn) {
          observed.snapshots.push(tenant);
          return scope.withTenant(tenant, () => fn({ query: async (sql, params) => {
            assert.equal(scope.currentTenant(), tenant);
            assert(!/pg_roles|pg_class|pg_namespace/.test(sql), 'no screen statement inside a tenant snapshot');
            observed.values++; assert.equal(params[0], tenant);
            return { rows: [{ version: 1, values: { DISPLAY_UNITS: 'mmol' }, generation: 1, policy: { deployment: {}, overrides: {} } }] };
          } }));
        }, async end () { observed.ended++; }
      };
      const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
      const original = loaded.require.bind(loaded), checks = original('../migrations/postgres-check');
      loaded.require = name => name === '../storage/postgres-connection' ? async () => connection
        : name === '../migrations/postgres-check' ? { ...checks, options: opts => opts, inspect: async (_query, opts) => { observed.catalogues.push(opts.namespace); return { current: true }; } } : original(name);
      const binding = 'connection.readOnlySnapshot(tenant, async ({ query }) => {';
      const startup = 'try { await check(); }';
      assert(source.includes(binding)); assert(source.includes(startup));
      let selected = wrongBinding ? source.replace(binding, "connection.readOnlySnapshot('00000000-0000-0000-0000-000000000000', async ({ query }) => {") : source;
      if (omitScreen) selected = selected.replace(startup, 'try { void check; }');
      loaded._compile(selected, file); return { open: loaded.exports, observed };
    }
    function lazy (open) {
      const loaded = new Module(lazyFile, module); loaded.filename = lazyFile; loaded.paths = Module._nodeModulePaths(path.dirname(lazyFile));
      const original = loaded.require.bind(loaded); loaded.require = name => name === './effective-postgres' ? open : original(name);
      loaded._compile(fs.readFileSync(lazyFile, 'utf8'), lazyFile); return loaded.exports(options);
    }
    scope.setTenancyMode('multi');
    try {
      for (const tenant of [A, B]) {
        const f = factory(), reader = lazy(f.open);
        await scope.withTenant(tenant, async () => {
          assert.equal((await reader.read(tenant)).effective.DISPLAY_UNITS.value, 'mmol');
          assert.equal((await reader.read(tenant)).effective.DISPLAY_UNITS.value, 'mmol');
          await reader.close();
        });
        assert.deepEqual(f.observed.snapshots, [tenant, tenant]);
        // Opening screened once; neither read screens.
        assert.equal(f.observed.metadata, 1); assert.equal(f.observed.values, 2); assert.equal(f.observed.ended, 1);
        assert.deepEqual(f.observed.catalogues, ['settings', 'policy']);
      }
      const unbound = factory(), resource = await unbound.open(options);
      assert.deepEqual(unbound.observed.snapshots, [], 'opening the lazy resource invents no metadata tenant');
      await assert.rejects(resource.read('not-canonical'), /Canonical settings tenant/);
      assert.equal(unbound.observed.metadata, 1, 'the open screen only'); await resource.close();
      assert.throws(() => scope.withTenant(A, () => scope.withTenant(B, () => {})), /cannot rebind/);
      const broken = factory({ wrongBinding: true }), rebound = await broken.open(options);
      await assert.rejects(scope.withTenant(A, () => rebound.read(A)), /cannot rebind/);
      assert.equal(broken.observed.values, 0); await rebound.close();
      const unsafe = factory({ unsafe: true });
      await assert.rejects(unsafe.open(options), /unsafe settings identity/, 'an unsafe store yields no capability');
      assert.equal(unsafe.observed.values, 0); assert.equal(unsafe.observed.ended, 1);
      const omitted = factory({ unsafe: true, omitScreen: true }), bypassed = await omitted.open(options);
      assert.equal((await scope.withTenant(A, () => bypassed.read(A))).effective.DISPLAY_UNITS.value, 'mmol', 'omitting the actual screen falsifies denied-read protection');
      await bypassed.close();
    } finally { scope.setTenancyMode(previous); }
  });

});
