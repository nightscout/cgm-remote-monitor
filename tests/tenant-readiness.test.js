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
function load (relative, overrides) {
  const filename = path.resolve(__dirname, '..', relative), local = createRequire(filename);
  const sandbox = { module: { exports: {} }, setInterval: () => { throw new Error('SOURCE_TEST_TIMER_FORBIDDEN'); }, clearInterval: () => {},
    console: { log () {}, warn () {} }, process, require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename }); return sandbox.module.exports;
}
async function withReadiness (value, fn) {
  const previous = process.env.NS_TENANT_READINESS;
  if (value === undefined) delete process.env.NS_TENANT_READINESS; else process.env.NS_TENANT_READINESS = value;
  try { return await fn(); } finally { if (previous === undefined) delete process.env.NS_TENANT_READINESS; else process.env.NS_TENANT_READINESS = previous; }
}
// The actual api boot (lib/server/serve/preview-api.js) with recorded storage:
// BROKEN's root credential metadata is missing, the misconfiguration the api's
// tenant initializer refuses ("incomplete preview root preparation").
function apiBoot () {
  const initialized = new Set(), calls = {}, resource = extra => ({ end: async () => {}, ...extra });
  const boot = load('lib/server/serve/preview-api.js', {
    '../../storage/postgres-connection': async () => resource(),
    '../../secrets/legacy-postgres': async () => resource({ read: async tenant => tenant === BROKEN ? null : { reference: { id: 'synthetic' } } }),
    '../../tenant-authorization/postgres': async () => resource({ authorize: async () => {} }),
    '../../secrets/postgres': { createPostgresSecrets: async () => resource({ store: { get: async () => ({}) } }) },
    '../../secrets/component': { createSecrets: () => ({}) },
    './postgres-domains': { readiness: async () => {}, assertServing: async () => ({ ensure: async () => {}, invalidateTenant: () => {} }) },
    './preview-domains': async () => ({ initializeTenant: async tenant => { await new Promise(resolve => setImmediate(resolve)); initialized.add(tenant); }, data: () => {}, safeRoutes: {} }),
    '../tenant-app/exchange': () => () => {}, '../tenant-app/data-access': () => () => {},
    '../tenant-app': { createTenantApp: input => { calls.http = input.prepareTenant; return (req, res, next) => next(); } }
  });
  const config = { bindings: new Map(TENANTS.map(tenant => [tenant, {}])), providers: new Map(), namespaces: {} };
  return { boot: () => boot.boot(config), initialized, calls };
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
});
