'use strict';

// covers: lib/server/serve/tenant-startup.js, lib/server/serve/preview-api.js, lib/server/serve/pool-config.js, lib/server/tenant-app/index.js

// Decision readiness-serve-then-warm: a role is ready once its own dependencies
// are up; tenants warm in the background with bounded concurrency; a tenant not
// yet warm answers 503 with Retry-After for that tenant only; a misconfigured
// tenant fails alone and alerts; NS_TENANT_READINESS=all keeps "ready means every
// tenant initialized". Source protocol with recorded dependencies (no PostgreSQL);
// synthetic tenants only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { createRequire } = require('node:module');
const request = require('supertest');
const startup = require('../lib/server/serve/tenant-startup');
const scope = require('../lib/storage/tenant-scope');

const tenantOf = i => '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0');
const TENANTS = Array.from({ length: 100 }, (_, i) => tenantOf(i));
const BROKEN = TENANTS[37];
function load (relative, overrides, transform = source => source) {
  const filename = path.resolve(__dirname, '..', relative), local = createRequire(filename);
  const sandbox = { module: { exports: {} }, setInterval: () => { throw new Error('SOURCE_TEST_TIMER_FORBIDDEN'); }, clearInterval: () => {},
    console: { log () {}, warn () {} }, process, require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name) };
  vm.runInNewContext(transform(fs.readFileSync(filename, 'utf8')), sandbox, { filename }); return sandbox.module.exports;
}
async function withReadiness (value, fn) {
  const previous = process.env.NS_TENANT_READINESS;
  if (value === undefined) delete process.env.NS_TENANT_READINESS; else process.env.NS_TENANT_READINESS = value;
  try { return await fn(); } finally { if (previous === undefined) delete process.env.NS_TENANT_READINESS; else process.env.NS_TENANT_READINESS = previous; }
}
// Actual API boot with recorded dependencies. Every tenant builds inline on
// demand, without a roster warm-up and without a per-tenant platform gate.
function apiBoot ({ display, proof = true, transform } = {}) {
  const admitted = [];
  const initialized = new Set(), calls = {}, resource = extra => ({ end: async () => {}, ...extra });
  const boot = load('lib/server/serve/preview-api.js', {
    './role-readiness': { ...require('../lib/server/serve/role-readiness'), admit: async (_config, role) => {
      admitted.push(role);
      if (!proof) throw Object.assign(new Error('PLATFORM_SERVING_IDENTITY_UNSAFE'), { code: 'PLATFORM_SERVING_IDENTITY_UNSAFE' });
    } },
    ...(display ? { '../../tenant-settings/presentation-reader': (_config, options) => {
      assert.deepEqual(admitted, ['api'], 'display trust follows role admission');
      calls.settingsOptions = options; return display;
    } } : {}),
    '../../storage/postgres-connection': async () => resource(),
    '../../secrets/legacy-postgres': async () => resource({ read: async tenant => tenant === BROKEN ? null : { reference: { id: 'synthetic' } } }),
    '../../tenant-authorization/postgres': async () => resource({ authorize: async () => {} }),
    '../../secrets/postgres': { createPostgresSecrets: async () => resource({ store: { get: async () => ({}) } }) },
    '../../secrets/component': { createSecrets: () => ({}) },
    './preview-domains': async () => ({ prepareTenant: async tenant => { await new Promise(resolve => setImmediate(resolve)); initialized.add(tenant); }, invalidateTenant () {}, invalidateAll () {}, data: () => {}, safeRoutes: {} }),
    '../tenant-app/exchange': () => () => {}, '../tenant-app/data-access': () => () => {},
    '../tenant-app': { createTenantApp: input => { calls.http = input.prepareTenant; return (req, res, next) => next(); } }
  }, transform);
  const config = { bindings: new Map(TENANTS.map(tenant => [tenant, {}])), providers: new Map(), namespaces: { clock: 'synthetic_clock' }, ...(display ? { tenantSettings: {} } : {}) };
  return { boot: () => boot.boot(config), initialized, calls, admitted, setProof: value => { proof = value; } };
}

describe('tenant readiness: serve, then warm (decision readiness-serve-then-warm)', function () {
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));

  it('boots without scanning tenants and builds each tenant on demand with no per-tenant platform gate', async function () {
    const lab = apiBoot(), role = await withReadiness(undefined, lab.boot);
    try {
      assert.equal(role.health().ready, true);
      assert.equal(lab.initialized.size, 0, 'API_BOOT_MUST_NOT_TOUCH_ROSTER');
      for (const tenant of TENANTS) await lab.calls.http(tenant);
      assert.equal(lab.initialized.size, TENANTS.length);
      assert.equal(role.health().ready, true, 'ONE_TENANT_FAILURE_MUST_NOT_WITHDRAW_ROLE');
    } finally { await role.close(); }
  });

  it('API runs its start check once, starts cold and admits one tenant on demand', async function () {
    const lab = apiBoot(), role = await withReadiness('serve', lab.boot);
    try {
      assert.deepEqual(lab.admitted, ['api'], 'ONE_START_CHECK');
      await role.warmed(); assert.equal(lab.initialized.size, 0, 'VERIFIED_API_MUST_NOT_WARM_IDLE_ROSTER');
      await lab.calls.http(TENANTS[0]);
      assert.equal(lab.initialized.size, 1);
      // A start check that would now refuse does not refuse requests already
      // admitted: it runs at the next start.
      lab.setProof(false);
      await lab.calls.http(TENANTS[0]); await request(role.app).get('/api/v1/entries').expect(res => assert.notEqual(res.status, 503));
      assert.equal(role.health().ready, true, 'REQUESTS_CONTINUE_WITHOUT_LEASE');
      assert.deepEqual(lab.admitted, ['api'], 'NO_RECHECK_WHILE_SERVING');
    } finally { await role.close(); }
  });

  it('refuses to start when its login can bypass row-level security, with its typed code and no listener', async function () {
    const lab = apiBoot({ proof: false });
    await assert.rejects(withReadiness('serve', lab.boot), { code: 'PLATFORM_SERVING_IDENTITY_UNSAFE' });
    assert.deepEqual(lab.admitted, ['api']); assert.equal(lab.calls.http, undefined, 'NO_APP_WITH_UNSAFE_IDENTITY');
  });

  it('control: removing the start check lets an unsafe API start (red); restored source refuses', async function () {
    const omitCheck = source => {
      const needle = "await roleReadiness.admit(config, 'api');";
      assert.equal(source.split(needle).length, 2, 'START_CHECK_CONTROL_SEAM_REQUIRED');
      return source.replace(needle, '');
    };
    const criterion = async transform => {
      const lab = apiBoot({ proof: false, transform });
      let role;
      try { role = await withReadiness('serve', lab.boot); } catch (error) { assert.equal(error.code, 'PLATFORM_SERVING_IDENTITY_UNSAFE'); return; }
      await role.close(); assert.fail('UNSAFE_API_MUST_NOT_START');
    };
    await criterion();
    await assert.rejects(criterion(omitCheck), /UNSAFE_API_MUST_NOT_START/);
    console.log('    CONTROL RED: UNSAFE_API_MUST_NOT_START');
    await criterion();
    console.log('    CONTROL RESTORED: PLATFORM_SERVING_IDENTITY_UNSAFE');
  });

  // Actual API composition with recorded dependencies. Storage health depends
  // only on this process's own state.
  for (const displayState of [undefined, { ready: true, state: 'ready' }, { ready: false, state: 'pending' },
    { ready: false, state: 'unavailable', code: 'SETTINGS_STORE_UNSAFE' }]) {
    it('reports storage health without a platform lease with display ' + (displayState?.state || 'absent'), async function () {
      let reads = 0;
      const display = displayState ? { health: () => displayState, check: async () => displayState,
        read: async () => { reads++; throw new Error('DISPLAY_READ_MUST_NOT_GATE_INGESTION'); }, close: async () => {} } : undefined;
      const lab = apiBoot({ display }), role = await withReadiness('serve', lab.boot);
      try {
        await lab.calls.http(TENANTS[0]);
        assert.equal(role.health().storageReady, true, 'VERIFIED_STORAGE_ADMISSION_REQUIRED');
        assert.equal(role.health().ready, true, 'DISPLAY_COMPONENT_MUST_NOT_WITHDRAW_DATA_READY');
        assert.equal(reads, 0, 'DISPLAY_SCREEN_FAILURE_MUST_NOT_READ_OR_GATE_INGESTION');
        role.quiesce();
        assert.equal(role.health().storageReady, false, 'QUIESCED_ROLE_MUST_REFUSE_STORAGE_HEALTH');
        assert.equal(role.health().ready, false);
      } finally { await role.close(); }
    });
  }

  it('NS_TENANT_READINESS=all adds no API roster warm-up requirement', async function () {
    const lab = apiBoot(), role = await withReadiness('all', lab.boot);
    try {
      assert.equal(role.health().ready, true);
      assert.equal(lab.initialized.size, 0, 'ALL_MUST_NOT_WARM_API_ROSTER');
      await lab.calls.http(TENANTS[0]);
      assert.equal(lab.initialized.size, 1);
    } finally { await role.close(); }
  });

  it('NS_TENANT_READINESS=all boots only once every tenant is initialized', async function () {
    const initialized = new Set();
    const healthy = startup.create(TENANTS, undefined, async tenant => { await new Promise(resolve => setImmediate(resolve)); initialized.add(tenant); },
      { readiness: 'all', concurrency: 4, coldAlertMs: undefined });
    try {
      assert.equal(healthy.health().ready, false, 'not ready before warm');
      await healthy.warm();
      assert.equal(initialized.size, 100); assert.equal(healthy.health().ready, true);
    } finally { healthy.close(); }
  });

  it('refuses invalid NS_TENANT_READINESS', function () {
    const config = require('../lib/server/serve/pool-config');
    assert.equal(config.tenantReadiness({}), 'serve'); assert.equal(config.tenantReadiness({ NS_TENANT_READINESS: 'all' }), 'all');
    assert.throws(() => config.tenantReadiness({ NS_TENANT_READINESS: 'some' }), /NS_TENANT_READINESS/);
  });

  it('a cold tenant is refused TENANT_WARMING with Retry-After and moves to the front of the warm queue', async function () {
    const order = [], held = new Map();
    const s = startup.create(TENANTS.slice(0, 10), undefined, tenant => { order.push(tenant); return new Promise(resolve => held.set(tenant, resolve)); },
      { readiness: 'serve', concurrency: 1, coldAlertMs: undefined });
    try {
      await s.warm();
      assert.deepEqual(order, [TENANTS[0]]);
      await assert.rejects(s.admit(TENANTS[9]), error => error.code === 'TENANT_WARMING' && error.retryAfter === 5);
      held.get(TENANTS[0])(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
      assert.equal(order[1], TENANTS[9], 'the requested tenant warms next');
      held.get(TENANTS[9])(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
      await s.admit(TENANTS[9]);
      await s.admit(TENANTS[0]);
    } finally { for (const resolve of held.values()) resolve(); s.close(); }
  });

  it('answers 503 with Retry-After for the cold tenant only, over HTTP', async function () {
    const { createTenantApp } = require('../lib/server/tenant-app');
    const warm = TENANTS[0], cold = TENANTS[1];
    const s = startup.create([warm, cold], undefined, tenant => tenant === warm ? Promise.resolve() : new Promise(() => {}), { readiness: 'serve', concurrency: 2, coldAlertMs: undefined });
    try {
      await s.warm(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
      const express = require('express'); const router = express.Router(); router.get('/api/v1/entries', (req, res) => res.json([]));
      const unavailable = async () => { throw new Error('not selected'); };
      const app = createTenantApp({ resolver: { resolve: req => req.get('x-synthetic-tenant') }, dataRouter: router, prepareTenant: tenant => s.admit(tenant),
        verifyCredential: async () => null, authorizeRequest: async () => true,
        tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable }, subjectPolicy: { read: unavailable, replace: unavailable } });
      const refused = await request(app).get('/api/v1/entries').set('x-synthetic-tenant', cold);
      assert.equal(refused.status, 503); assert.equal(refused.headers['retry-after'], '5'); assert.deepEqual(refused.body, { error: 'TENANT_WARMING' });
      const served = await request(app).get('/api/v1/entries').set('x-synthetic-tenant', warm);
      assert.notEqual(served.status, 503);
    } finally { s.close(); }
  });

  it('raises an alert while a tenant stays cold beyond the bound, and clears it once warm', async function () {
    let clock = 0, release; const alerts = [];
    const s = startup.create([TENANTS[0]], undefined, () => new Promise(resolve => { release = resolve; }),
      { readiness: 'serve', concurrency: 1, coldAlertMs: 1000, now: () => clock, alert: (code, tenant) => alerts.push([code, tenant]) });
    try {
      await s.warm(); clock = 999; await new Promise(resolve => setTimeout(resolve, 300));
      assert.deepEqual(alerts, []);
      clock = 1000; await new Promise(resolve => setTimeout(resolve, 300));
      assert.deepEqual(alerts, [['TENANT_COLD_BEYOND_BOUND', TENANTS[0]]]);
      assert.deepEqual(s.health().alerts, [{ tenant: TENANTS[0], code: 'TENANT_COLD_BEYOND_BOUND' }]);
      release(); await s.drained();
      assert.deepEqual(s.health().alerts, []); assert.equal(s.health().ready, true);
    } finally { if (release) release(); s.close(); }
  });

  it('keeps at most the configured number of tenants warming in the background', async function () {
    let inFlight = 0, most = 0;
    const s = startup.create(TENANTS, undefined, async () => { inFlight++; most = Math.max(most, inFlight); await new Promise(r => setTimeout(r, 1)); inFlight--; },
      { readiness: 'serve', concurrency: 4, coldAlertMs: undefined });
    try { await s.warm(); await s.drained(); assert.equal(most, 4); assert.equal(s.health().ready, true); assert.equal(s.health().failed, 0); }
    finally { s.close(); }
  });

  // Admin owns the settings screen. Its admitted proof permits API boot before
  // the independent presentation capability opens; DATA readiness is local.
  it('serves DATA before display opens, never screens settings at attach/recovery, and reports component failure independently', async function () {
    let state = { ready: false, state: 'pending' }, checks = 0, reads = 0;
    const display = { check: async () => { checks++; if (display.refuse) { state = { ready: false, state: 'unavailable', code: 'SETTINGS_STORE_UNSAFE' }; throw Object.assign(new Error('unsafe settings scope'), { code: 'SETTINGS_STORE_UNSAFE' }); } state = { ready: true, state: 'ready' }; return state; },
      health: () => state, read: async () => { reads++; }, close: async () => {} };
    const lab = apiBoot({ display });
    const role = await withReadiness(undefined, lab.boot);
    const turn = () => new Promise(resolve => setImmediate(resolve));
    try {
      await turn();
      assert.equal(checks, 0, 'no display store probe precedes the DATA listener');
      assert.equal(lab.calls.settingsOptions.platformVerified, true, 'API skips the display store screen');
      assert.equal(role.health().ready, true, 'pending presentation reads do not withdraw DATA readiness');
      assert.equal(role.health().displaySettings.state, 'pending');
      await role.attach({}); await turn();
      role.resume(); await turn();
      assert.equal(checks, 0, 'attach and datastore recovery run no settings metadata screen');
      state = { ready: false, state: 'unavailable', code: 'SETTINGS_POLICY_UNAVAILABLE' };
      assert.equal(role.health().ready, true); assert.equal(role.health().displaySettings.code, 'SETTINGS_POLICY_UNAVAILABLE');
      await lab.calls.http(TENANTS[0]); assert(lab.initialized.has(TENANTS[0]), 'raw DATA still admits a tenant');
      assert.equal(reads, 0, 'no screen is driven through a tenant read');
    } finally { await role.close(); }
    const refused = apiBoot({ display, proof: false });
    await assert.rejects(refused.boot(), { code: 'PLATFORM_SERVING_IDENTITY_UNSAFE' });
    assert.equal(refused.calls.settingsOptions, undefined, 'no display trust is constructed after a refused start check');
  });
});
