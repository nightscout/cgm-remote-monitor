'use strict';

// Source protocol for durable pause/suspend eligibility: the actual evaluator
// runtime and owner router with synthetic tenants, activity rows and
// authenticators. Native PostgreSQL/worker evidence is in
// tests/tenant-activity.integration.test.js.
// covers: lib/tenant-activity/policy.js, lib/tenant-activity/eligibility.js, lib/tenant-activity/owner.js, lib/tenant-activity/config.js
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const policy = require('../lib/tenant-activity/policy');
const eligibility = require('../lib/tenant-activity/eligibility');
const { createOwnerActivity } = require('../lib/tenant-activity/owner');
const startRuntime = require('../lib/server/serve/evaluator-runtime');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const row = (paused = false, suspended = false, version = 1) => ({ version, paused, suspended, state: policy.stateOf({ paused, suspended }) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

describe('tenant activity policy', function () {
  it('has exactly pause and suspend, suspend wins, and the operation matrix of the decision', function () {
    assert.deepEqual(policy.STATES, ['active', 'paused', 'suspended']);
    assert.equal(policy.stateOf({ paused: true, suspended: true }), 'suspended');
    assert.equal(policy.stateOf({ paused: true, suspended: false }), 'paused');
    assert.throws(() => policy.stateOf({ paused: 'yes', suspended: false }), { code: 'ACTIVITY_UNAVAILABLE' });
    const matrix = {};
    for (const op of Object.keys(policy.OPERATIONS)) matrix[op] = policy.STATES.filter(state => policy.eligible(op, state));
    assert.deepEqual(matrix, { evaluator: ['active'], notification: ['active'], read: ['active'], ingest: ['active', 'paused'], connector: ['active', 'paused'] });
    assert.equal(policy.eligible('evaluator', 'unknown'), false);
  });
  it('lets an owner pause and unpause only; never suspend or act on a suspended site', function () {
    assert.deepEqual(policy.apply('owner', 'pause', row()), { paused: true, suspended: false });
    assert.deepEqual(policy.apply('owner', 'unpause', row(true)), { paused: false, suspended: false });
    for (const verb of ['suspend', 'unsuspend']) assert.throws(() => policy.apply('owner', verb, row()), { code: 'ACTIVITY_FORBIDDEN' });
    assert.throws(() => policy.apply('owner', 'unpause', row(true, true)), { code: 'ACTIVITY_SUSPENDED' });
    assert.deepEqual(policy.apply('operator', 'suspend', row(true)), { paused: true, suspended: true });
    assert.deepEqual(policy.apply('operator', 'unsuspend', row(true, true)), { paused: true, suspended: false }, 'unsuspend keeps an owner pause');
    assert.throws(() => policy.apply('operator', 'delete', row()), { code: 'ACTIVITY_VERB_INVALID' });
  });
  it('states in plain language that alarms stop while paused', function () {
    assert.match(policy.OWNER_NOTICE.pause, /alarms are not computed or delivered/);
    assert.match(policy.OWNER_NOTICE.pause, /another way to be alerted/);
    assert.match(policy.OWNER_NOTICE.unpause, /recalculates from your current data before/);
    assert.match(policy.OWNER_NOTICE.pause, /cannot be viewed/);
    assert.match(policy.OWNER_NOTICE.suspended, /uploads are refused/);
    assert.match(policy.OWNER_NOTICE.deletion, /Alarms stop now/);
  });
  it('classifies HTTP requests: writes, preflight and the credential exchange are uploads; everything else is a read', async function () {
    const { operationOf, createServingGate } = require('../lib/tenant-activity/serving');
    const req = (method, path) => ({ method, path });
    assert.deepEqual(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map(m => operationOf(req(m, '/api/v1/entries'))), Array(5).fill('ingest'));
    assert.equal(operationOf(req('GET', '/api/v2/authorization/request/token-1')), 'ingest');
    for (const path of ['/api/v1/entries', '/', '/api/v3/entries', '/api/v1/status.json', '/api/v2/authorization/request/a/b']) assert.equal(operationOf(req('GET', path)), 'read');
    assert.equal(operationOf(req('HEAD', '/')), 'read'); assert.equal(operationOf(undefined), 'ingest');
    const rows = new Map([[A, row(true)], [B, row(false, true)]]);
    const gate = createServingGate(eligibility.create({ read: async tenant => rows.get(tenant) }));
    await gate(A, req('POST', '/api/v1/entries'));
    await assert.rejects(gate(A, req('GET', '/api/v1/entries')), { code: 'TENANT_PAUSED' });
    await assert.rejects(gate(B, req('POST', '/api/v1/entries')), { code: 'TENANT_SUSPENDED' });
    await assert.rejects(gate(B, req('GET', '/')), { code: 'TENANT_SUSPENDED' });
    rows.delete(A); await assert.rejects(gate(A, req('POST', '/api/v1/entries')), { code: 'TENANT_ACTIVITY_UNAVAILABLE' });
  });
  it('builds connector work lists from eligibility, not configuration', async function () {
    const rows = new Map([[A, row(true)], [B, row(false, true)]]);
    const gate = eligibility.create({ read: async tenant => rows.get(tenant) });
    const list = await gate.connectorWorkList([A, B]);
    assert.deepEqual(list.eligible, [A], 'paused keeps polling; suspended does not');
    assert.deepEqual(list.skipped.map(s => s.code), ['TENANT_SUSPENDED']);
    const missing = await eligibility.create({ read: async () => null }).check('evaluator', A);
    assert.equal(missing.code, 'ACTIVITY_NOT_PROVISIONED');
    const broken = await eligibility.create({ read: async () => { throw new Error('down'); } }).check('evaluator', A);
    assert.deepEqual([broken.eligible, broken.code], [false, 'ACTIVITY_UNAVAILABLE']);
  });
  it('parses the operator selection and refuses unsafe or ambiguous namespaces', function () {
    const parse = require('../lib/tenant-activity/config').parse;
    const invalid = () => { throw new Error('invalid'); };
    assert.equal(parse({ connectionEnv: 'NS_ACT', namespace: 'activity' }, { NS_ACT: 'postgres://x' }, { invalid }).connectionString, 'postgres://x');
    for (const value of [{ connectionEnv: 'NS_ACT', namespace: 'public' }, { connectionEnv: 'ns', namespace: 'a' },
      { connectionEnv: 'NS_ACT', namespace: 'a', extra: 1 }, { connectionEnv: 'NS_MISSING', namespace: 'a' }]) {
      assert.throws(() => parse(value, { NS_ACT: 'postgres://x' }, { invalid }), /invalid/);
    }
    assert.throws(() => parse({ connectionEnv: 'NS_ACT', namespace: 'taken' }, { NS_ACT: 'x' }, { invalid, reserved: ['taken'] }), /invalid/);
  });
});

function lab ({ initial = {}, hold } = {}) {
  const rows = new Map([[A, row()], [B, row()], ...Object.entries(initial)]);
  const calls = [], timers = [];
  const runtime = startRuntime({ tenants: [A, B], recoveryIntervalMs: 10, timeIntervalMs: 10,
    readCurrent: async tenant => ({ tenant, identity: 'a'.repeat(64), env: {} }),
    activity: eligibility.create({ read: async tenant => { const value = rows.get(tenant); if (value instanceof Error) throw value; return value; } }),
    schedule: fn => { timers.push(fn); return timers.length; }, cancel: () => {},
    // Due-time timers are per tenant; `time` below fires each tenant's time-only trigger, as a due timer does.
    setTimer: () => ({}), clearTimer: () => {},
    create: async current => {
      calls.push(['create', current.tenant]);
      return { async evaluate () { calls.push(['acquisition', current.tenant]); if (hold && hold.tenant === current.tenant && hold.armed) await hold.gate.promise; return { checkpoint: 1 }; },
        async evaluateTime () { calls.push(['time-only', current.tenant]); return { checkpoint: 1 }; },
        close () { calls.push(['close', current.tenant]); } };
    } });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { rows, calls, runtime, recovery: async () => { await timers[0](); await (await runtime).backstop(); await settle(); },
    time: async () => { const r = await runtime; await Promise.all([A, B].map(tenant => r.tick(tenant))); await settle(); },
    of: tenant => calls.filter(call => call[1] === tenant).map(call => call[0]) };
}

describe('evaluator work list from durable activity (actual runtime, synthetic component)', function () {
  it('runs no acquisition, component, timer cycle or output for a paused tenant; B is unaffected', async function () {
    const t = lab({ initial: { [A]: row(true) } }); const runtime = await t.runtime;
    await t.time(); await t.recovery(); await runtime.tick(A); await runtime.acquire(A);
    assert.deepEqual(t.of(A), [], 'ACTIVITY_PAUSED_NO_WORK A must have no work at all');
    assert.deepEqual(t.of(B).slice(0, 3), ['create', 'acquisition', 'time-only']);
    assert.equal(runtime.last(A), null); assert.equal(runtime.last(B).eligible, true);
    const health = Object.fromEntries(runtime.health().tenants.map(s => [s.tenant, s]));
    assert.deepEqual([health[A].code, health[A].activity, health[A].ready], ['EVALUATOR_TENANT_PAUSED', 'paused', false]);
    assert.equal(health[B].ready, true);
    assert.equal(await runtime.isCurrent(A, 'a'.repeat(64)), false, 'consumers refuse a paused tenant');
    await runtime.close();
  });
  it('retires output on pause and recomputes by acquisition before publishing on unpause', async function () {
    const t = lab(); const runtime = await t.runtime;
    assert.equal(runtime.last(A).trigger, 'acquisition');
    t.rows.set(A, row(true, false, 2)); await t.time();
    assert.equal(runtime.last(A), null, 'ACTIVITY_PAUSE_RETIRES_OUTPUT');
    assert.deepEqual(t.of(A), ['create', 'acquisition', 'close']);
    t.calls.length = 0;
    t.rows.set(A, row(false, false, 3)); await t.time(); // a time-only trigger after unpause
    assert.deepEqual(t.of(A), ['create', 'acquisition'], 'ACTIVITY_UNPAUSE_RECOMPUTES first work after unpause is a fresh acquisition');
    assert.equal(runtime.last(A).trigger, 'acquisition'); assert.equal(runtime.last(A).eligible, true);
    await t.time(); assert.deepEqual(t.of(A), ['create', 'acquisition', 'time-only']);
    await runtime.close();
  });
  it('does not publish a cycle that was in flight when the tenant was paused', async function () {
    const hold = { tenant: A, armed: false, gate: deferred() };
    const t = lab({ hold }); const runtime = await t.runtime;
    hold.armed = true; const pending = runtime.acquire(A); await new Promise(resolve => setImmediate(resolve));
    t.rows.set(A, row(true, false, 2)); hold.gate.resolve(); await pending;
    assert.equal(runtime.last(A), null, 'ACTIVITY_INFLIGHT_FENCED');
    assert.equal(runtime.health().tenants.find(s => s.tenant === A).code, 'EVALUATOR_TENANT_PAUSED');
    await runtime.close();
  });
  it('treats suspended, unprovisioned and unreadable activity as ineligible with distinct codes', async function () {
    const t = lab({ initial: { [A]: row(false, true) } }); const runtime = await t.runtime;
    assert.deepEqual(t.of(A), []);
    assert.equal(runtime.health().tenants.find(s => s.tenant === A).code, 'EVALUATOR_TENANT_SUSPENDED');
    t.rows.delete(A); await t.time();
    assert.equal(runtime.health().tenants.find(s => s.tenant === A).code, 'EVALUATOR_ACTIVITY_NOT_PROVISIONED');
    assert.deepEqual(t.of(A), []);
    await runtime.close();
  });
  it('stops only A when A\'s activity read fails, with a health code and one warning; B keeps cycling', async function () {
    const t = lab(); const runtime = await t.runtime;
    const warnings = []; const warn = console.warn; console.warn = (...args) => warnings.push(args.join(' '));
    try {
      t.rows.set(A, new Error('synthetic unreadable row'));
      t.calls.length = 0; await t.time(); await t.recovery(); await t.time();
      assert.deepEqual(t.of(A), ['close'], 'ACTIVITY_UNREADABLE_STOPS_A only the retirement of the old component');
      assert.deepEqual(t.of(B), ['time-only', 'acquisition', 'time-only'], 'ACTIVITY_UNREADABLE_B_CONTINUES');
      const health = Object.fromEntries(runtime.health().tenants.map(s => [s.tenant, s]));
      assert.equal(health[A].code, 'EVALUATOR_ACTIVITY_UNAVAILABLE'); assert.equal(health[B].ready, true);
      assert.equal(warnings.filter(w => w.includes(A) && w.includes('EVALUATOR_ACTIVITY_UNAVAILABLE')).length, 1, 'one warning per change');
    } finally { console.warn = warn; }
    await runtime.close();
  });
  it('keeps a paused tenant paused across invalidation (restore activation) and restart', async function () {
    const t = lab({ initial: { [A]: row(true) } }); const runtime = await t.runtime;
    await runtime.invalidateTenant(A); await t.time(); await t.recovery();
    assert.deepEqual(t.of(A), []); assert.equal(runtime.health().tenants.find(s => s.tenant === A).code, 'EVALUATOR_TENANT_PAUSED');
    await runtime.close();
    const restarted = lab({ initial: { [A]: row(true) } }); const again = await restarted.runtime;
    assert.deepEqual(restarted.of(A), [], 'ACTIVITY_RESTART_PRESERVES fresh runtime derives nothing from boot');
    await again.close();
  });
});

function ownerApp (store) {
  const tokens = { 'owner-a': { tenant: A, principal: 'owner', consumer: 'tenant-admin' },
    'owner-b': { tenant: B, principal: 'owner', consumer: 'tenant-admin' } };
  const hosts = { 'a.example.test': A, 'b.example.test': B };
  const app = express();
  // Synthetic authenticator: the token names the tenant it was issued for and
  // the SAME principal name exists in both tenants, as tenant-local names do.
  app.use('/api/v1/tenant', require('../lib/server/tenant-app/owner-settings')({
    resolver: { resolve: async req => hosts[req.headers.host] },
    authenticateManagement: async ({ credential }) => tokens[credential] || null,
    tenantSettings: { read: async () => ({}), replace: async () => ({}), rollback: async () => ({}) },
    tenantActivity: createOwnerActivity({ store, authorize: async actor => actor.principal === 'owner' && actor.consumer === 'tenant-admin' })
  }));
  return app;
}
function memoryStore (initial = {}) {
  const rows = new Map([[A, { version: 1, paused: false, suspended: false }], [B, { version: 1, paused: false, suspended: false }], ...Object.entries(initial)]);
  const audit = [];
  const view = tenant => ({ tenant, ...rows.get(tenant), state: policy.stateOf(rows.get(tenant)) });
  return { rows, audit, capability: 'owner', read: async tenant => view(tenant),
    async transition (actor, verb, { expectedVersion } = {}) {
      const current = rows.get(actor.tenant);
      if (expectedVersion !== undefined && expectedVersion !== current.version) throw Object.assign(new Error('c'), { code: 'ACTIVITY_VERSION_CONFLICT' });
      const next = policy.apply('owner', verb, current);
      rows.set(actor.tenant, { version: current.version + 1, ...next });
      audit.push({ tenant: actor.tenant, verb, principal: actor.principal }); return view(actor.tenant);
    } };
}

describe('owner pause/unpause API (actual router, synthetic authenticator and store)', function () {
  it('lets the owner of A pause and unpause A with an audit row and the plain-language notice', async function () {
    const store = memoryStore(), app = ownerApp(store);
    const read = await request(app).get('/api/v1/tenant/activity').set('Host', 'a.example.test').set('Authorization', 'Bearer owner-a');
    assert.equal(read.status, 200); assert.equal(read.body.state, 'active');
    assert.match(read.body.notice, /alarms are not computed or delivered/);
    const paused = await request(app).post('/api/v1/tenant/activity/pause').set('Host', 'a.example.test')
      .set('Authorization', 'Bearer owner-a').send({ expectedVersion: 1 });
    assert.equal(paused.status, 200); assert.equal(paused.body.state, 'paused');
    assert.match(paused.body.notice, /alarms are not computed or delivered/);
    assert.deepEqual(store.audit, [{ tenant: A, verb: 'pause', principal: 'owner' }]);
    const stale = await request(app).post('/api/v1/tenant/activity/unpause').set('Host', 'a.example.test')
      .set('Authorization', 'Bearer owner-a').send({ expectedVersion: 1 });
    assert.deepEqual([stale.status, stale.body.error], [409, 'ACTIVITY_VERSION_CONFLICT']);
    const resumed = await request(app).post('/api/v1/tenant/activity/unpause').set('Host', 'a.example.test')
      .set('Authorization', 'Bearer owner-a').send({ expectedVersion: 2 });
    assert.equal(resumed.body.state, 'active');
  });
  it('refuses the owner of A on B, owner suspend, and owner action on a suspended site', async function () {
    const store = memoryStore({ [B]: { version: 1, paused: false, suspended: false } }), app = ownerApp(store);
    const cross = await request(app).post('/api/v1/tenant/activity/pause').set('Host', 'b.example.test')
      .set('Authorization', 'Bearer owner-a').send({ expectedVersion: 1 });
    assert.equal(cross.status, 401, 'ACTIVITY_CROSS_TENANT owner of A cannot pause B');
    assert.equal(store.rows.get(B).paused, false); assert.deepEqual(store.audit, []);
    const suspend = await request(app).post('/api/v1/tenant/activity/suspend').set('Host', 'a.example.test')
      .set('Authorization', 'Bearer owner-a').send({ expectedVersion: 1 });
    assert.equal(suspend.status, 404, 'no owner suspend route');
    await assert.rejects(createOwnerActivity({ store, authorize: async () => true }).transition({ tenant: A, principal: 'owner', consumer: 'tenant-admin' }, 'suspend', 1),
      { code: 'ACTIVITY_FORBIDDEN' });
    store.rows.set(A, { version: 5, paused: true, suspended: true });
    const lifted = await request(app).post('/api/v1/tenant/activity/unpause').set('Host', 'a.example.test')
      .set('Authorization', 'Bearer owner-a').send({ expectedVersion: 5 });
    assert.deepEqual([lifted.status, lifted.body.error], [409, 'ACTIVITY_SUSPENDED']);
    assert.equal(store.rows.get(A).suspended, true);
    const unauthorized = createOwnerActivity({ store, authorize: async () => false });
    await assert.rejects(unauthorized.read({ tenant: A, principal: 'viewer', consumer: 'tenant-admin' }), { code: 'ACTIVITY_FORBIDDEN' });
  });
});

describe('realtime sockets under pause and suspend (actual protocol and runtime, synthetic sockets)', function () {
  const { EventEmitter } = require('node:events');
  const scope = require('../lib/storage/tenant-scope');
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));
  class Socket extends EventEmitter {
    constructor (host) { super(); this.request = { headers: { host }, rawHeaders: ['Host', host], socket: {} }; this.sent = []; this.rooms = new Set(['self']); this.id = 'self'; }
    emit (event, value) { this.sent.push({ event, value }); return true; }
    async receive (event, ...args) { return Promise.all(this.listeners(event).map(fn => fn(...args))); }
    join (name) { this.rooms.add(name); }
    leave (name) { this.rooms.delete(name); }
    disconnect () { this.disconnected = true; super.emit('disconnect'); }
  }
  async function realtime () {
    const rows = new Map([[A, row()], [B, row()]]), writes = new Map([[A, 0], [B, 0]]);
    const env = require('../lib/server/tenant-app/environment')({ settings: { enable: ['bgnow'] } });
    const hosts = { 'a.test': A, 'b.test': B };
    let protocol, runtime; const schedule = {};
    const readCurrent = require('../lib/tenant-activity/serving').gateReadCurrent({
      check: eligibility.create({ read: async tenant => rows.get(tenant) }).check,
      readCurrent: async tenant => ({ tenant, identity: 'same', env }), invalidate: tenant => protocol.invalidateTenant(tenant) });
    const api = { executeSocketMutation: async () => ({ replyArgs: [{ result: 'success' }] }),
      authorizeSocket: async () => ({ permissions: { read: true, write: true, write_treatment: true, ack: true }, collections: ['entries'] }) };
    protocol = require('../lib/server/realtime/protocol').create({ admission: { resolve: async req => { const t = hosts[req.headers.host]; if (!t) throw new Error('UNKNOWN'); return t; } },
      api, readCurrent, runtime: () => runtime, domains: ['entries'] });
    runtime = await require('../lib/server/realtime/runtime')({ tenants: [A, B], readCurrent, recoveryIntervalMs: 100,
      create: selected => ({ acquire: async () => ({ tenant: selected.tenant, checkpoint: writes.get(selected.tenant), rows: [],
        frame: { delta: false, lastUpdated: 1000, sgvs: Array.from({ length: writes.get(selected.tenant) }, (_, i) => ({ mgdl: 100 + i, mills: 1000 + i })) } }) }),
      fanout: protocol.fanout, schedule: callback => { schedule.callback = callback; return 1; }, cancel: () => {} });
    return { rows, writes, protocol, runtime, schedule,
      async socket (host) { const socket = new Socket(host); await protocol.prepare(socket); protocol.bind(socket, '/'); await socket.receive('authorize', { secret: 'synthetic' }); return socket; },
      async close () { protocol.close(); await runtime.close(); } };
  }
  for (const [label, paused, suspended] of [['paused', true, false], ['suspended', false, true]]) {
    it('disconnects A sockets and refuses new ones while ' + label + '; B keeps its socket and updates', async function () {
      const f = await realtime();
      try {
        const a = await f.socket('a.test'), b = await f.socket('b.test');
        assert.notEqual(a.disconnected, true);
        f.rows.set(A, row(paused, suspended, 2));
        // Publish on change: B gets a write, so its view changes and it receives a frame.
        const before = b.sent.length; f.writes.set(B, 1);
        await f.schedule.callback(); // actual recovery refresh, no wake
        assert.equal(a.disconnected, true, 'ACTIVITY_SOCKET_DISCONNECTED');
        assert.notEqual(b.disconnected, true); assert.ok(b.sent.length > before, 'B still receives updates');
        assert.equal(f.runtime.last(A), null);
        const late = await f.socket('a.test');
        assert.ok(late.disconnected === true || !late.sent.some(m => m.event === 'dataUpdate'), 'ACTIVITY_SOCKET_REFUSED no data for a new A socket');
        assert.equal(late.sent.some(m => m.event === 'dataUpdate'), false);
      } finally { await f.close(); }
    });
  }
});
