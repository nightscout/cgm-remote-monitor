'use strict';

// Realtime serves at once and reads a tenant's output when it is watched: the
// actual level runtime and protocol with synthetic sockets, a synthetic
// projection and api double. No tenant is read at start.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const scope = require('../lib/storage/tenant-scope');
const protocolFactory = require('../lib/server/realtime/protocol');
const runtimeFactory = require('../lib/server/realtime/runtime');
const { AsyncLocalStorage } = require('node:async_hooks');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// The operation window's scope rule (lib/tenant-lifecycle/operation-window.js
// execute): work started inside a finished operation refuses.
function scopedWindow () {
  const scopes = new AsyncLocalStorage();
  return {
    async run (tenant, fn) {
      const outer = scopes.getStore();
      if (outer) {
        if (outer.tenant !== tenant || !outer.active) throw Object.assign(new Error('LIFECYCLE_WINDOW_SCOPE_INVALID'), { code: 'LIFECYCLE_WINDOW_SCOPE_INVALID' });
        return fn();
      }
      const state = { tenant, active: true };
      await sleep(0);
      try { return await scopes.run(state, fn); } finally { state.active = false; }
    },
    current (tenant) { const value = scopes.getStore(); return !!value && value.tenant === tenant && value.active; }
  };
}
const env = require('../lib/server/tenant-app/environment')({ settings: { enable: ['bgnow'] } });
const id = i => '44444444-4444-4444-8444-' + String(i).padStart(12, '0');
class Socket extends EventEmitter {
  constructor (host) { super(); this.request = { headers: { host }, rawHeaders: ['Host', host], socket: {} }; this.sent = []; this.rooms = new Set(['self']); this.id = 'self'; }
  emit (event, value) { this.sent.push({ event, value }); return true; }
  async receive (event, ...args) { return Promise.all(this.listeners(event).map(fn => fn(...args))); }
  join (name) { this.rooms.add(name); }
  leave (name) { this.rooms.delete(name); }
  disconnect () { this.disconnected = true; super.emit('disconnect'); }
  frames () { return this.sent.filter(row => row.event === 'dataUpdate'); }
}
async function until (predicate, timeoutMs) { const t0 = Date.now(); while (!predicate()) { if (Date.now() - t0 > timeoutMs) return false; await sleep(5); } return true; }
async function lab ({ tenants, broken = new Set(), gate = new Map(), levelMs = 20, acquireMs = 0, operationWindow }) {
  const attempts = new Map(), load = { inFlight: 0, max: 0 }, known = new Set(tenants);
  const readCurrent = async tenant => ({ tenant, identity: 'same', env });
  const admission = { resolve: async req => req.headers.host.split('.')[0] };
  let runtime;
  const protocol = protocolFactory.create({ operationWindow, admission, readCurrent, runtime: () => runtime, domains: ['entries'],
    retry: { minMs: 5, maxMs: 40 },
    api: { executeSocketMutation: async () => ({ replyArgs: [] }),
      authorizeSocket: async () => ({ permissions: { read: true, write: false, write_treatment: false, ack: false }, collections: ['entries'] }) } });
  runtime = await runtimeFactory({ operationWindow, readCurrent, concurrency: 2, levelMs, flushMs: 5,
    watched: () => protocol.watchedTenants(), isWatched: tenant => protocol.watched(tenant), lagging: () => protocol.lagging(),
    readRevisions: async list => new Map(list.map(t => [t, { eligible: known.has(t), revision: '1' }])),
    create: selected => ({ async acquire () {
      attempts.set(selected.tenant, (attempts.get(selected.tenant) || 0) + 1);
      if (broken.has(selected.tenant)) throw new Error('REPLAY_NOT_PROVISIONED');
      if (gate.has(selected.tenant) && !gate.get(selected.tenant).warm) throw Object.assign(new Error('TENANT_WARMING'), { code: 'TENANT_WARMING' });
      load.inFlight++; load.max = Math.max(load.max, load.inFlight);
      try { if (acquireMs) await sleep(acquireMs); } finally { load.inFlight--; }
      return { tenant: selected.tenant, checkpoint: 1, rows: [], frame: { delta: false, lastUpdated: 1, sgvs: [{ mgdl: 100, mills: 1 }] } };
    } }), fanout: protocol.fanout });
  return { runtime, protocol, attempts, load, broken,
    async socket (tenant) { const s = new Socket(tenant + '.test'); await protocol.prepare(s); protocol.bind(s, '/'); s.receive('authorize', { secret: 'synthetic' }); return s; },
    async close () { protocol.close(); await runtime.close(); } };
}
describe('realtime readiness: serve at once, read when watched', function () {
  this.timeout(20000);
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));
  it('RD_ONE_BROKEN: one broken tenant among 100 does not hold the others; it is read again each level pass and its socket stays connected', async function () {
    const tenants = Array.from({ length: 100 }, (_, i) => id(i)), bad = tenants[37];
    const f = await lab({ tenants, broken: new Set([bad]), levelMs: 100 });
    try {
      assert.equal(f.attempts.size, 0, 'no tenant is read before it is watched');
      const stuck = await f.socket(bad), sockets = await Promise.all(tenants.filter(t => t !== bad).map(t => f.socket(t)));
      assert.ok(await until(() => sockets.every(s => s.frames().length === 1), 5000), 'RD_ONE_BROKEN the other 99 tenants\' sockets get data');
      await sleep(350);
      assert.equal(stuck.frames().length, 0); assert.notEqual(stuck.disconnected, true, 'an output that cannot be read withholds the frame and keeps the socket');
      const tries = f.attempts.get(bad);
      assert.ok(tries >= 2 && tries <= 8, 'the broken tenant is read again at the level interval, not faster: ' + tries);
      assert.ok(tenants.every(t => t === bad || f.attempts.get(t) === 1), 'a current tenant is not read again');
      f.broken.clear();
      assert.ok(await until(() => stuck.frames().length === 1, 2000), 'RD_ONE_BROKEN_CONVERGES the tenant is sent its frame once its output can be read');
    } finally { await f.close(); }
  });
  it('RD_COLD_SOCKET: a socket for a cold tenant stays connected and gets data once the tenant is warm', async function () {
    const tenants = [id(1), id(2)];
    // The cold tenant's refresh refuses (as a warming tenant does) until it is warm.
    const cold = { warm: false }, release = () => { cold.warm = true; };
    const f = await lab({ tenants, gate: new Map([[tenants[0], cold]]), levelMs: 50 });
    try {
      const socket = await f.socket(tenants[0]);
      await sleep(200);
      assert.equal(socket.frames().length, 0, 'no data while cold');
      assert.notEqual(socket.disconnected, true, 'RD_COLD_SOCKET not refused or disconnected while cold');
      release();
      assert.ok(await until(() => socket.frames().length === 1, 2000), 'RD_COLD_SOCKET data once warm');
      assert.notEqual(socket.disconnected, true);
    } finally { await f.close(); }
  });
  it('RD_RESTART_BOUNDED: 200 sockets reconnecting to 100 cold tenants all get data, with output reads at the runtime bound and one per tenant', async function () {
    const tenants = Array.from({ length: 100 }, (_, i) => id(i));
    const f = await lab({ tenants, acquireMs: 15, operationWindow: scopedWindow() });
    try {
      const sockets = [];
      for (const tenant of tenants) for (let k = 0; k < 2; k++) sockets.push(await f.socket(tenant));
      assert.ok(await until(() => sockets.every(s => s.frames().length >= 1), 15000), 'RD_RESTART_ALL_PRIMED ' + sockets.filter(s => s.frames().length).length + '/200');
      assert.equal(sockets.filter(s => s.disconnected).length, 0);
      assert.ok(f.load.max <= 2, 'RD_RESTART_BOUND concurrent warms ' + f.load.max + ' (runtime concurrency 2)');
      assert.ok(tenants.every(t => f.attempts.get(t) === 1), 'RD_RESTART_ONE_READ one output read per tenant, not per socket');
    } finally { await f.close(); }
  });
});
