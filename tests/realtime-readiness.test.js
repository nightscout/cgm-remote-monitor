'use strict';

// Decision readiness-serve-then-warm for realtime: the actual runtime and
// protocol with synthetic sockets, a synthetic projection and api double.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const scope = require('../lib/storage/tenant-scope');
const protocolFactory = require('../lib/server/realtime/protocol');
const runtimeFactory = require('../lib/server/realtime/runtime');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
async function lab ({ tenants, readiness, broken = new Set(), gate = new Map(), failureRetryMs = 60000, acquireMs = 0 }) {
  const attempts = new Map(), load = { inFlight: 0, max: 0 };
  const readCurrent = async tenant => ({ tenant, identity: 'same', env });
  const admission = { resolve: async req => req.headers.host.split('.')[0] };
  let runtime;
  const protocol = protocolFactory.create({ admission, readCurrent, runtime: () => runtime, maxSockets: 1000, domains: ['entries'],
    retry: { minMs: 5, maxMs: 40 },
    api: { executeSocketMutation: async () => ({ replyArgs: [] }),
      authorizeSocket: async () => ({ permissions: { read: true, write: false, write_treatment: false, ack: false }, collections: ['entries'] }) } });
  runtime = await runtimeFactory({ tenants, readCurrent, recoveryIntervalMs: 20, concurrency: 2, readiness, failureRetryMs,
    detect: async list => new Map(list.map(t => [t, { stamp: '1', identity: 'same' }])),
    create: selected => ({ async acquire () {
      attempts.set(selected.tenant, (attempts.get(selected.tenant) || 0) + 1);
      if (broken.has(selected.tenant)) throw new Error('REPLAY_NOT_PROVISIONED');
      if (gate.has(selected.tenant) && !gate.get(selected.tenant).warm) throw Object.assign(new Error('TENANT_WARMING'), { code: 'TENANT_WARMING' });
      load.inFlight++; load.max = Math.max(load.max, load.inFlight);
      try { if (acquireMs) await sleep(acquireMs); } finally { load.inFlight--; }
      return { tenant: selected.tenant, checkpoint: 1, rows: [], frame: { delta: false, lastUpdated: 1, sgvs: [{ mgdl: 100, mills: 1 }] } };
    } }), fanout: protocol.fanout, onReady: tenant => protocol.tenantReady(tenant) });
  return { runtime, protocol, attempts, load,
    async socket (tenant) { const s = new Socket(tenant + '.test'); await protocol.prepare(s); protocol.bind(s, '/'); s.receive('authorize', { secret: 'synthetic' }); return s; },
    async close () { protocol.close(); await runtime.close(); } };
}
describe('realtime readiness: serve, then warm', function () {
  this.timeout(20000);
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));
  it('RD_ONE_BROKEN: one broken tenant among 100 does not stop the boot; the other 99 serve; it is retried only after the retry interval', async function () {
    const tenants = Array.from({ length: 100 }, (_, i) => id(i)), bad = tenants[37];
    const f = await lab({ tenants, readiness: 'serve', broken: new Set([bad]) });
    try {
      assert.ok(await until(() => f.runtime.health().healthy === 99, 10000), 'RD_ONE_BROKEN 99 tenants warm: ' + f.runtime.health().healthy);
      const health = f.runtime.health();
      assert.equal(health.ready, true); assert.equal(health.failed, 1);
      const sockets = await Promise.all([f.socket(tenants[0]), f.socket(tenants[99])]);
      assert.ok(await until(() => sockets.every(s => s.frames().length === 1), 2000), 'other tenants\' sockets get data');
      await sleep(300);
      assert.equal(f.attempts.get(bad), 1, 'the broken tenant is not retried before failureRetryMs');
    } finally { await f.close(); }
  });
  it('RD_COLD_SOCKET: a socket for a cold tenant stays connected and gets data once the tenant is warm', async function () {
    const tenants = [id(1), id(2)];
    // The cold tenant's refresh refuses (as a warming tenant does) until it is warm.
    const cold = { warm: false }, release = () => { cold.warm = true; };
    const f = await lab({ tenants, readiness: 'serve', gate: new Map([[tenants[0], cold]]), failureRetryMs: 50 });
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
  it('RD_RESTART_BOUNDED: 200 sockets reconnecting to 100 cold tenants all prime, and warming stays at the runtime bound', async function () {
    const tenants = Array.from({ length: 100 }, (_, i) => id(i));
    const f = await lab({ tenants, readiness: 'serve', acquireMs: 15 });
    try {
      const sockets = [];
      for (const tenant of tenants) for (let k = 0; k < 2; k++) sockets.push(await f.socket(tenant));
      assert.ok(await until(() => sockets.every(s => s.frames().length >= 1), 15000), 'RD_RESTART_ALL_PRIMED ' + sockets.filter(s => s.frames().length).length + '/200');
      assert.equal(sockets.filter(s => s.disconnected).length, 0);
      assert.ok(f.load.max <= 2, 'RD_RESTART_BOUND concurrent warms ' + f.load.max + ' (runtime concurrency 2)');
      assert.ok(f.protocol.stats().parked >= 1, 'sockets for cold tenants waited for the runtime warm');
    } finally { await f.close(); }
  });
  it('RD_FLAG_ALL: NS_TENANT_READINESS=all restores all-tenants readiness: a broken tenant refuses the boot; healthy ones are ready before start returns', async function () {
    const tenants = Array.from({ length: 10 }, (_, i) => id(i));
    await assert.rejects(lab({ tenants, readiness: 'all', broken: new Set([tenants[3]]) }), /REPLAY_NOT_PROVISIONED/);
    const f = await lab({ tenants, readiness: 'all' });
    try { assert.equal(f.runtime.health().ready, true); assert.equal(f.runtime.health().healthy, 10); }
    finally { await f.close(); }
    assert.equal(require('../lib/server/serve/pool-config').tenantReadiness({ NS_TENANT_READINESS: 'all' }), 'all');
    assert.equal(require('../lib/server/serve/pool-config').tenantReadiness({}), 'serve');
  });
});
