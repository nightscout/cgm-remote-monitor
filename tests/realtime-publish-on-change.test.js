'use strict';

// Publish on change (decision cost-proportional-to-activity): the actual
// realtime protocol, runtime and change detector with synthetic sockets, a
// counting api double and a synthetic projection. No listener, PG or Vault.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const scope = require('../lib/storage/tenant-scope');
const protocolFactory = require('../lib/server/realtime/protocol');
const runtimeFactory = require('../lib/server/realtime/runtime');
const detectorFactory = require('../lib/server/realtime/change-detector');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const env = require('../lib/server/tenant-app/environment')({ settings: { enable: ['bgnow'] } });
class Socket extends EventEmitter {
  constructor (host) { super(); this.request = { headers: { host }, rawHeaders: ['Host', host], socket: {} }; this.sent = []; this.rooms = new Set(['self']); this.id = 'self'; }
  emit (event, value) { this.sent.push({ event, value, at: Date.now() }); return true; }
  async receive (event, ...args) { return Promise.all(this.listeners(event).map(fn => fn(...args))); }
  join (name) { this.rooms.add(name); }
  leave (name) { this.rooms.delete(name); }
  disconnect () { this.disconnected = true; this.disconnectedAt = Date.now(); super.emit('disconnect'); }
  frames () { return this.sent.filter(row => row.event === 'dataUpdate'); }
}
function jwt (exp) {
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return part({ alg: 'HS256', typ: 'JWT' }) + '.' + part({ accessToken: 'synthetic', exp }) + '.c2lnbmF0dXJl';
}
// pool: optional { capacity } makes the operation window refuse (as a pool
// connect timeout does) while more than `capacity` windows are open.
async function fixture ({ recoveryIntervalMs = 20, authorizationRecheckMs = 60000, pool, tenants = [A, B], activity } = {}) {
  const state = { writes: new Map(tenants.map(t => [t, 0])), visible: new Map(tenants.map(t => [t, 0])), revoked: new Set(),
    calls: 0, acquisitions: 0, windows: 0, open: 0, refusedWindows: 0, activity: new Map(tenants.map(t => [t, 'active'])) };
  const hosts = { 'a.test': A, 'b.test': B };
  const admission = { resolve: async req => { const t = hosts[req.headers.host]; if (!t) throw new Error('UNKNOWN'); return t; } };
  let protocol, runtime;
  const configRead = async tenant => ({ tenant, identity: 'same', env });
  const readCurrent = activity ? require('../lib/tenant-activity/serving').gateReadCurrent({
    check: require('../lib/tenant-activity/eligibility').create({ read: async t => ({ state: state.activity.get(t) }) }).check,
    readCurrent: configRead, invalidate: t => protocol.invalidateTenant(t) }) : configRead;
  const api = {
    executeSocketMutation: async () => ({ replyArgs: [{ result: 'success' }] }),
    async authorizeSocket (body) {
      state.calls++;
      const credential = Object.values(body.credential)[0];
      if (state.revoked.has(credential)) return { denied: true };
      const exp = protocolFactory.expiryOf(body.credential);
      if (exp !== null && exp <= Date.now()) return { denied: true };
      const read = Object.keys(body.credential).length > 0;
      return { permissions: { read, write: read, write_treatment: read, ack: read }, collections: read ? ['entries'] : [] };
    } };
  const operationWindow = pool ? {
    async run (tenant, fn) {
      // Exhausted: other tenants' and roles' work holds the pool until exhaustedUntil.
      if (state.open >= pool.capacity || Date.now() < (pool.exhaustedUntil || 0)) { state.refusedWindows++; await sleep(2); throw new Error('timeout exceeded when trying to connect'); }
      state.open++; state.windows++;
      try { await sleep(5); return await fn(); } finally { state.open--; }
    },
    current: () => true } : undefined;
  protocol = protocolFactory.create({ admission, api, readCurrent, runtime: () => runtime, maxSockets: 2000, domains: ['entries'],
    operationWindow, authorizationRecheckMs, retry: { minMs: 5, maxMs: 40 } });
  const detector = detectorFactory.create({
    readStamps: async list => new Map(list.map(t => [t, String(state.writes.get(t))])),
    readIdentities: async list => new Map(list.map(t => [t, { identity: 'same' }])),
    ...(activity ? { readActivity: async list => new Map(list.map(t => [t, { state: state.activity.get(t) }])) } : {}),
    onPoll: seen => detectorFactory.invalidateIneligible(seen, { activity: !!activity, invalidate: t => protocol.invalidateTenant(t) }) });
  runtime = await runtimeFactory({ tenants, readCurrent, recoveryIntervalMs, detect: detector.poll, concurrency: 2,
    create: selected => ({ async acquire () {
      state.acquisitions++;
      const n = state.visible.get(selected.tenant);
      return { tenant: selected.tenant, checkpoint: state.writes.get(selected.tenant), rows: [],
        frame: { delta: false, lastUpdated: Date.now(), sgvs: Array.from({ length: n }, (_, i) => ({ mgdl: 100 + i, mills: 1000 + i })) } };
    } }), fanout: protocol.fanout });
  return { state, protocol, runtime, detector,
    write (tenant, visible = true) { state.writes.set(tenant, state.writes.get(tenant) + 1); if (visible) state.visible.set(tenant, state.visible.get(tenant) + 1); },
    async socket (host = 'a.test', credential = { secret: 'synthetic' }, namespace = '/') {
      const socket = new Socket(host); await protocol.prepare(socket); protocol.bind(socket, namespace);
      await socket.receive(namespace === '/' ? 'authorize' : 'subscribe', credential); return socket;
    },
    async close () { protocol.close(); await runtime.close(); } };
}
async function until (predicate, timeoutMs, stepMs = 5) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeoutMs) return false; await sleep(stepMs); }
  return true;
}
describe('realtime publish on change (actual protocol, runtime and detector)', function () {
  this.timeout(20000);
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));

  it('RT_IDLE_NO_FRAME: no change sends no frame, acquires nothing and calls the api for nothing', async function () {
    const f = await fixture();
    try {
      const sockets = await Promise.all(Array.from({ length: 20 }, () => f.socket()));
      assert.ok(sockets.every(s => s.frames().length === 1), 'each socket primed with one frame');
      const calls = f.state.calls, acquisitions = f.state.acquisitions, ticks = f.runtime.stats().ticks;
      await sleep(400);
      assert.ok(f.runtime.stats().ticks - ticks >= 10, 'the detector ran');
      assert.equal(sockets.reduce((sum, s) => sum + s.frames().length, 0), 20, 'RT_IDLE_NO_FRAME no frame after priming');
      assert.equal(f.state.acquisitions, acquisitions, 'RT_IDLE_NO_ACQUISITION no projection read while the stamp is unchanged');
      assert.equal(f.state.calls, calls, 'RT_IDLE_NO_AUTHORIZATION no api call while idle');
    } finally { await f.close(); }
  });

  it('RT_WRITE_FRAME: a write reaches every socket of the tenant within one interval; others get nothing', async function () {
    const f = await fixture({ recoveryIntervalMs: 50 });
    try {
      const a = await Promise.all(Array.from({ length: 5 }, () => f.socket())), b = await f.socket('b.test');
      const at = Date.now(); f.write(A);
      assert.ok(await until(() => a.every(s => s.frames().length === 2), 1000), 'every A socket receives the new frame');
      const latency = Math.max(...a.map(s => s.frames()[1].at)) - at;
      assert.ok(latency <= 50 + 40, 'RT_WRITE_BOUND within one detection interval (+ scheduling): ' + latency + ' ms');
      assert.equal(a[0].frames()[1].value.sgvs.length, 1); assert.equal(a[0].frames()[1].value.delta, false, 'frames stay full');
      assert.equal(b.frames().length, 1, 'RT_TENANT_FANOUT B receives nothing');
      f.write(A, false); const acquisitions = f.state.acquisitions;
      assert.ok(await until(() => f.state.acquisitions > acquisitions, 1000));
      await sleep(120);
      assert.ok(a.every(s => s.frames().length === 2), 'RT_SAME_VIEW a stamp move with an unchanged view sends nothing');
    } finally { await f.close(); }
  });

  it('RT_REVOCATION: a revoked credential is disconnected within the recheck bound and receives nothing after', async function () {
    const f = await fixture({ authorizationRecheckMs: 100 });
    try {
      const revoked = await f.socket('a.test', { secret: 'revoke-me' }), kept = await f.socket('a.test', { secret: 'keep' });
      const at = Date.now(); f.state.revoked.add('revoke-me');
      await sleep(100 + 60); f.write(A);
      assert.ok(await until(() => kept.frames().length === 2, 1000));
      assert.equal(revoked.frames().length, 1, 'RT_REVOCATION_NO_DATA no frame after one recheck interval');
      assert.equal(revoked.disconnected, true, 'disconnected');
      const latency = revoked.disconnectedAt - at;
      assert.ok(latency <= 100 + 60, 'RT_REVOCATION_BOUND within one recheck interval: ' + latency + ' ms');
      assert.notEqual(kept.disconnected, true);
    } finally { await f.close(); }
  });

  it('RT_RECHECK_DEDUP: one api call per distinct credential per recheck, not per socket', async function () {
    const f = await fixture({ authorizationRecheckMs: 100 });
    try {
      await Promise.all(Array.from({ length: 20 }, () => f.socket('a.test', { secret: 'shared' })));
      const calls = f.state.calls; await sleep(350);
      const sweeps = f.state.calls - calls;
      assert.ok(sweeps >= 2 && sweeps <= 4, 'RT_RECHECK_DEDUP one call per sweep for 20 sockets sharing a credential: ' + sweeps);
    } finally { await f.close(); }
  });

  it('RT_EXPIRY: authorization lapses at the credential expiry without waiting for the periodic recheck', async function () {
    const f = await fixture({ authorizationRecheckMs: 60000 });
    try {
      const exp = Math.floor(Date.now() / 1000) + 1, socket = await f.socket('a.test', { token: jwt(exp) });
      assert.equal(socket.frames().length, 1);
      assert.ok(await until(() => socket.disconnected, 2500), 'disconnected at expiry');
      assert.ok(socket.disconnectedAt >= exp * 1000 && socket.disconnectedAt - exp * 1000 < 200, 'RT_EXPIRY_BOUND ' + (socket.disconnectedAt - exp * 1000) + ' ms after exp');
    } finally { await f.close(); }
  });

  for (const label of ['paused', 'suspended']) it('RT_ACTIVITY: ' + label + ' disconnects the tenant within one detection interval; B keeps its socket', async function () {
    const f = await fixture({ activity: true, recoveryIntervalMs: 50 });
    try {
      const a = await f.socket(), b = await f.socket('b.test');
      const at = Date.now(); f.state.activity.set(A, label);
      assert.ok(await until(() => a.disconnected, 1000));
      assert.ok(a.disconnectedAt - at <= 50 + 40, 'RT_ACTIVITY_BOUND ' + (a.disconnectedAt - at) + ' ms');
      assert.notEqual(b.disconnected, true);
      const late = await f.socket();
      assert.ok(late.disconnected === true || !late.frames().length, 'a new A socket gets no data');
    } finally { await f.close(); }
  });

  it('RT_PRESSURE: 50 simultaneous connects under pool pressure are all primed late, none disconnected', async function () {
    const pool = { capacity: 2 };
    const f = await fixture({ pool });
    try {
      pool.exhaustedUntil = Date.now() + 150;
      const sockets = await Promise.all(Array.from({ length: 50 }, async () => {
        const socket = new Socket('a.test'); await f.protocol.prepare(socket); f.protocol.bind(socket, '/');
        socket.receive('authorize', { secret: 'synthetic' }); return socket;
      }));
      assert.ok(await until(() => sockets.every(s => s.frames().length >= 1), 5000), 'RT_PRESSURE_ALL_PRIMED ' + sockets.filter(s => s.frames().length).length + '/50');
      assert.equal(sockets.filter(s => s.disconnected).length, 0, 'RT_PRESSURE_NONE_DROPPED');
      assert.ok(f.state.refusedWindows > 0, 'the pool refused windows during the connects: ' + f.state.refusedWindows);
      assert.ok(f.state.windows < 25, 'priming is batched per tenant: ' + f.state.windows + ' windows for 50 sockets');
      assert.ok(f.state.calls <= 10, 'one api call per distinct credential per batch: ' + f.state.calls);
    } finally { await f.close(); }
  });

  it('RT_SHUTDOWN (BF-233): close sends no server-side disconnect; the socket server closes the transports', async function () {
    const f = await fixture();
    const sockets = await Promise.all([f.socket(), f.socket('b.test'), f.socket('a.test', { secret: 's' }, '/alarm')]);
    await f.close();
    assert.ok(sockets.every(s => !s.disconnected), 'RT_SHUTDOWN_NO_SERVER_DISCONNECT');
  });

  it('RT_DETECTOR: one stamp and identity read per poll for all tenants', async function () {
    const reads = [];
    const detector = detectorFactory.create({ readStamps: async list => { reads.push(['stamps', list.length]); return new Map([[A, '7']]); },
      readIdentities: async list => { reads.push(['identities', list.length]); return new Map([[A, { identity: 'x' }]]); } });
    const seen = await detector.poll([A, B]);
    assert.deepEqual(reads, [['stamps', 2], ['identities', 2]]);
    assert.deepEqual(seen.get(A), { stamp: '7', identity: 'x' }); assert.deepEqual(seen.get(B), { stamp: null, identity: null });
    const stamps = detectorFactory.stampReader({ connection: { scanTenants: async (tenants, text) => {
      assert.match(text, /^SELECT last_stamp::text AS stamp FROM "rt_clock"\.tenant_write_clock WHERE tenant_id = nullif\(current_setting/);
      return new Map(tenants.map(t => [t, t === A ? [{ stamp: '3' }] : []]));
    } }, clockNamespace: 'rt_clock' });
    assert.deepEqual([...await stamps([A, B])], [[A, '3'], [B, null]]);
  });
});
