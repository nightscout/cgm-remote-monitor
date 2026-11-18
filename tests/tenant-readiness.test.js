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
// The actual api boot (lib/server/serve/preview-api.js) with recorded storage:
// BROKEN's root credential metadata is missing, the misconfiguration the api's
// tenant initializer refuses ("incomplete preview root preparation").
function apiBoot ({ display, verified = false, transform } = {}) {
  let verificationReady = true;
  const initialized = new Set(), calls = {}, resource = extra => ({ end: async () => {}, ...extra });
  const boot = load('lib/server/serve/preview-api.js', {
    './platform-verification': {guard:async()=>({ready:()=>verificationReady,health:()=>({ready:verificationReady}),verify:async()=>{},close:async()=>{}})},
    ...(display ? { '../../tenant-settings/presentation-reader': () => display } : {}),
    '../../storage/postgres-connection': async () => resource(),
    '../../secrets/legacy-postgres': async () => resource({ read: async tenant => tenant === BROKEN ? null : { reference: { id: 'synthetic' } } }),
    '../../tenant-authorization/postgres': async () => resource({ authorize: async () => {} }),
    '../../secrets/postgres': { createPostgresSecrets: async () => resource({ store: { get: async () => ({}) } }) },
    '../../secrets/component': { createSecrets: () => ({}) },
    './postgres-domains': { readiness: async () => {}, assertServing: async () => ({ ensure: async () => {}, invalidateTenant: () => {} }) },
    './preview-domains': async () => ({ initializeTenant: async tenant => { await new Promise(resolve => setImmediate(resolve)); initialized.add(tenant); }, data: () => {}, safeRoutes: {} }),
    '../tenant-app/exchange': () => () => {}, '../tenant-app/data-access': () => () => {},
    '../tenant-app': { createTenantApp: input => { calls.http = input.prepareTenant; return (req, res, next) => next(); } }
  }, transform);
  const config = { ...(verified ? {platformVerification:{namespace:'synthetic_verification',role:'api'}} : {}), bindings: new Map(TENANTS.map(tenant => [tenant, {}])), providers: new Map(), namespaces: {}, ...(display ? { tenantSettings: {} } : {}) };
  return { boot: () => boot.boot(config), initialized, calls, setVerified: value => {verificationReady=value;} };
}

describe('tenant readiness: serve, then warm (decision readiness-serve-then-warm)', function () {
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));

  it('boots with one broken tenant among 100: the others serve, the broken one alerts', async function () {
    const lab = apiBoot();
    const role = await withReadiness(undefined, lab.boot);
    try {
      assert.equal(role.health().readiness, 'serve');
      assert.equal(role.health().ready, true, 'the role is ready before its tenants are warm');
      await role.warmed();
      const health = role.health();
      assert.equal(health.ready, true); assert.equal(health.failed, 1); assert.equal(health.cold + health.warming, 0);
      assert.equal(lab.initialized.size, 99);
      assert.deepEqual(health.alerts, [{ tenant: BROKEN, code: 'TENANT_WARM_FAILED', cause: 'TENANT_WARM_FAILED' }]);
      for (const tenant of TENANTS.filter(t => t !== BROKEN)) await lab.calls.http(tenant);
      await assert.rejects(lab.calls.http(BROKEN), error => error.code === 'TENANT_UNAVAILABLE' && error.retryAfter > 0);
    } finally { await role.close(); }
  });

  it('selected verified API starts cold, admits one tenant on demand and refuses public/private traffic after verification loss', async function () {
    const lab=apiBoot({verified:true}),role=await withReadiness('serve',lab.boot);
    try{
      await role.warmed();assert.equal(lab.initialized.size,0,'VERIFIED_API_MUST_NOT_WARM_IDLE_ROSTER');
      await assert.rejects(lab.calls.http(TENANTS[0]),{code:'TENANT_WARMING'});await role.warmed();await lab.calls.http(TENANTS[0]);assert.equal(lab.initialized.size,1);
      lab.setVerified(false);assert.equal(role.health().ready,false);
      await assert.rejects(lab.calls.http(TENANTS[0]),{code:'PLATFORM_VERIFICATION_REQUIRED'});
      await request(role.app).get('/api/v1/entries').expect(503).expect('Retry-After','5').expect({error:'PLATFORM_VERIFICATION_REQUIRED'});
      lab.setVerified(true);await lab.calls.http(TENANTS[0]);assert.equal(role.health().ready,true);
    }finally{await role.close();}
  });

  // Actual API composition with recorded dependencies. The platform guard's
  // false verdict covers revoked and expired verification; database certificate
  // semantics are tested separately by the platform verification native suite.
  for (const displayState of [undefined, { ready: true, state: 'ready' }, { ready: false, state: 'pending' },
    { ready: false, state: 'unavailable', code: 'SETTINGS_STORE_UNSAFE' }]) {
    it('gates storage health on platform verification with display ' + (displayState?.state || 'absent'), async function () {
      let reads = 0;
      const display = displayState ? { health: () => displayState, check: async () => displayState,
        read: async () => { reads++; throw new Error('DISPLAY_READ_MUST_NOT_GATE_INGESTION'); }, close: async () => {} } : undefined;
      const lab = apiBoot({ display, verified: true }), role = await withReadiness('serve', lab.boot);
      const screenReady = displayState?.ready ?? true;
      try {
        await assert.rejects(lab.calls.http(TENANTS[0]), { code: 'TENANT_WARMING' });
        await role.warmed(); await lab.calls.http(TENANTS[0]);
        assert.equal(role.health().storageReady, true, 'VERIFIED_STORAGE_ADMISSION_REQUIRED');
        assert.equal(role.health().ready, screenReady, 'DISPLAY_SCREEN_ONLY_GATES_OVERALL_READY');
        for (const condition of ['revoked', 'expired']) {
          lab.setVerified(false);
          const refused = role.health();
          assert.equal(refused.ready, false, condition + ': PLATFORM_MUST_REFUSE_OVERALL_HEALTH');
          assert.equal(refused.storageReady, false, condition + ': PLATFORM_MUST_REFUSE_STORAGE_HEALTH');
          assert.equal(refused.platformVerification.ready, false);
          await assert.rejects(lab.calls.http(TENANTS[0]), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
          await request(role.app).get('/api/v1/entries').expect(503).expect({ error: 'PLATFORM_VERIFICATION_REQUIRED' });
          lab.setVerified(true);
          assert.equal(role.health().storageReady, true, 'RESTORED_PLATFORM_MUST_RESTORE_STORAGE_HEALTH');
          assert.equal(role.health().ready, screenReady);
          await lab.calls.http(TENANTS[0]);
        }
        assert.equal(reads, 0, 'DISPLAY_SCREEN_FAILURE_MUST_NOT_READ_OR_GATE_INGESTION');
        role.quiesce();
        assert.equal(role.health().storageReady, false, 'QUIESCED_ROLE_MUST_REFUSE_STORAGE_HEALTH');
        assert.equal(role.health().ready, false);
      } finally { await role.close(); }
    });
  }

  it('control: omitting the platform storage-health gate fails the actual API criterion; restored source passes', async function () {
    const criterion = async transform => {
      const display = { health: () => ({ ready: true, state: 'ready' }), check: async () => {}, close: async () => {} };
      const lab = apiBoot({ display, verified: true, transform }), role = await withReadiness('serve', lab.boot);
      try {
        assert.equal(role.health().storageReady, true);
        lab.setVerified(false);
        assert.equal(role.health().ready, false);
        assert.equal(role.health().storageReady, false, 'UNVERIFIED_PLATFORM_MUST_REFUSE_STORAGE_HEALTH');
        lab.setVerified(true); assert.equal(role.health().storageReady, true);
      } finally { await role.close(); }
    };
    await criterion();
    const omitGate = source => {
      const needle = 'storageReady: admitted && (current.storageReady ?? current.ready)';
      assert.equal(source.split(needle).length, 2, 'STORAGE_HEALTH_CONTROL_SEAM_REQUIRED');
      return source.replace(needle, 'storageReady: current.storageReady ?? current.ready');
    };
    await assert.rejects(criterion(omitGate), /UNVERIFIED_PLATFORM_MUST_REFUSE_STORAGE_HEALTH/);
    await criterion();
  });

  it('NS_TENANT_READINESS=all restores all-tenants readiness: the same broken tenant fails the boot', async function () {
    const lab = apiBoot();
    await assert.rejects(withReadiness('all', lab.boot), /preview readiness or storage initialization refused/);
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

  // Decision trusted-worker-performance-boundary: the display settings screen
  // runs after the listener opens and after a datastore recovery, never inside
  // a tenant read; a refused or pending screen is the role's not-ready.
  it('screens display settings after the listener opens and on resume, and reports a refusal as not ready', async function () {
    let state = { ready: false, state: 'pending' }, checks = 0, reads = 0;
    const display = { check: async () => { checks++; if (display.refuse) { state = { ready: false, state: 'unavailable', code: 'SETTINGS_STORE_UNSAFE' }; throw Object.assign(new Error('unsafe settings scope'), { code: 'SETTINGS_STORE_UNSAFE' }); } state = { ready: true, state: 'ready' }; return state; },
      health: () => state, read: async () => { reads++; }, close: async () => {} };
    const lab = apiBoot({ display });
    const role = await withReadiness(undefined, lab.boot);
    const turn = () => new Promise(resolve => setImmediate(resolve));
    try {
      await turn();
      assert.equal(checks, 0, 'no display store probe precedes the DATA listener');
      assert.equal(role.health().ready, false, 'a pending screen is not ready');
      await role.attach({}); await turn();
      assert.equal(checks, 1); assert.equal(role.health().ready, true); assert.equal(role.health().displaySettings.state, 'ready');
      display.refuse = true; role.resume(); await turn(); await turn();
      assert.equal(checks, 2, 'a recovery screens again');
      assert.equal(role.health().ready, false); assert.equal(role.health().displaySettings.code, 'SETTINGS_STORE_UNSAFE');
      display.refuse = false; role.resume(); await turn(); await turn();
      assert.equal(role.health().ready, true); assert.equal(reads, 0, 'no screen is driven through a tenant read');
    } finally { await role.close(); }
  });
});
