'use strict';

// Decision realtime-no-socket-cap (releases/cgm-remote-monitor-16.0.0): every
// server-side disconnect carries a cause code and a counter; a socket with no
// authorization answer and nothing pending is closed after a deadline, never
// while its authorization waits on the api; nothing tenant-scoped reaches an
// unauthorized socket. The actual protocol with synthetic sockets, a
// synthetic projection and api double. Synthetic data only.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const scope = require('../lib/storage/tenant-scope');
const protocolFactory = require('../lib/server/realtime/protocol');
const { CAUSES } = protocolFactory;
const A = '55555555-5555-4555-8555-555555555555';
const env = require('../lib/server/tenant-app/environment')({ settings: { enable: ['bgnow'] } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until (predicate, timeoutMs) { const t0 = Date.now(); while (!predicate()) { if (Date.now() - t0 > timeoutMs) return false; await sleep(5); } return true; }
class Socket extends EventEmitter {
  constructor () { super(); this.request = { headers: { host: 'a.test' }, rawHeaders: ['Host', 'a.test'], socket: {} }; this.sent = []; this.rooms = new Set(['self']); this.id = 'self'; this.connected = true; }
  emit (event, value) { if (this.emitThrows) throw new Error('synthetic send failure'); this.sent.push({ event, value }); return true; }
  async receive (event, ...args) { return Promise.all(this.listeners(event).map(fn => fn(...args))); }
  join (name) { this.rooms.add(name); }
  leave (name) { this.rooms.delete(name); }
  disconnect () { this.connected = false; this.disconnected = true; super.emit('disconnect'); }
}
const frameOf = sgv => ({ identity: 'same', checkpoint: sgv, rows: [], frame: { delta: false, lastUpdated: sgv, sgvs: [{ mgdl: 100 + sgv, mills: sgv }] } });
function lab ({ deadlineMs = 600000 } = {}) {
  // api: 'read' (all rights), 'noread' (answered, no read), 'denied', 'unavailable' (not ready: codeless, retried)
  const ctl = { api: 'read', window: 'pass', frame: frameOf(1) };
  const runtime = { warm: () => true, wake () {}, last: () => ctl.frame, fresh: async () => ctl.frame, refresh: async () => ctl.frame };
  const operationWindow = { async run (tenant, fn, { onInvalidated } = {}) {
    if (ctl.window === 'invalidate') { if (onInvalidated) onInvalidated(); throw Object.assign(new Error('LIFECYCLE_SYNTHETIC_TRANSPORT'), { code: 'LIFECYCLE_SYNTHETIC_TRANSPORT' }); }
    if (ctl.window === 'reject') throw Object.assign(new Error('LIFECYCLE_SYNTHETIC_REFUSED'), { code: 'LIFECYCLE_SYNTHETIC_REFUSED' });
    return fn();
  } };
  const api = { executeSocketMutation: async () => ({ replyArgs: [] }),
    async authorizeSocket () {
      if (ctl.api === 'unavailable') throw new Error('SOCKET_IPC_UNAVAILABLE');
      if (ctl.api === 'denied') return { denied: true };
      const read = ctl.api === 'read';
      return { permissions: { read, write: false, write_treatment: false, ack: read }, collections: read ? ['entries'] : [] };
    } };
  const protocol = protocolFactory.create({ operationWindow, admission: { resolve: async () => A }, api, readCurrent: async () => ({ identity: 'same', env }),
    runtime: () => runtime, domains: ['entries'], retry: { minMs: 5, maxMs: 20 }, unauthorizedDeadlineMs: deadlineMs });
  return { ctl, protocol,
    async socket (namespace, { prepare = true, bind = namespace } = {}) {
      const s = new Socket(); if (prepare) await protocol.prepare(s); protocol.bind(s, bind); return s;
    },
    async primed (namespace = '/') {
      const s = await this.socket(namespace);
      if (namespace !== '/') await s.receive('subscribe', {});
      assert.ok(await until(() => protocol.stats().primed >= 1, 2000), 'primed before the scenario');
      return s;
    },
    count: cause => protocol.stats().disconnects[cause] || 0,
    close () { protocol.close(); } };
}
// One scenario per cause: each must close the socket and count exactly that cause.
const SCENARIOS = {
  [CAUSES.CLOSED]: async f => { f.protocol.close(); return f.socket('/', { prepare: false }); },
  [CAUSES.NAMESPACE]: async f => f.socket('/', { bind: '/unknown' }),
  [CAUSES.UNPREPARED]: async f => f.socket('/', { prepare: false }),
  [CAUSES.CREDENTIAL]: async f => { const s = await f.socket('/'); await s.receive('authorize', { secret: 5 }); return s; },
  [CAUSES.PRIME_REFUSED]: async f => { f.ctl.api = 'denied'; return f.socket('/'); },
  [CAUSES.PRIME_WINDOW]: async f => { f.ctl.window = 'invalidate'; return f.socket('/'); },
  [CAUSES.RECHECK_REFUSED]: async f => { const s = await f.primed(); f.ctl.api = 'denied'; await f.protocol.recheckTenant(A); return s; },
  [CAUSES.RECHECK_READ_LOST]: async f => { const s = await f.primed(); f.ctl.api = 'noread'; await f.protocol.recheckTenant(A); return s; },
  [CAUSES.RETRO_WINDOW]: async f => { const s = await f.primed(); f.ctl.window = 'invalidate'; await s.receive('loadRetro', {}, () => {}); return s; },
  [CAUSES.RETRO_REFUSED]: async f => { const s = await f.primed(); f.ctl.window = 'reject'; await s.receive('loadRetro', {}, () => {}); return s; },
  [CAUSES.WRITE_WINDOW]: async f => { const s = await f.primed(); f.ctl.window = 'invalidate'; await s.receive('dbAdd', { collection: 'treatments', data: {} }, () => {}); return s; },
  [CAUSES.FANOUT]: async f => { const s = await f.primed(); s.emitThrows = true; await f.protocol.fanout({ tenant: A, previous: f.ctl.frame, next: frameOf(2) }); return s; },
  [CAUSES.ALARM_READ_LOST]: async f => { const s = await f.primed('/alarm'); f.ctl.api = 'noread'; await f.protocol.alarm({ tenant: A, notification: { level: 1 } }); return s; },
  [CAUSES.ALARM_REFUSED]: async f => { const s = await f.primed('/alarm'); f.ctl.api = 'denied'; await f.protocol.alarm({ tenant: A, notification: { level: 1 } }); return s; },
  [CAUSES.TENANT_INVALIDATED]: async f => { const s = await f.primed(); f.protocol.invalidateTenant(A, 'role'); return s; },
  [CAUSES.UNAUTHORIZED_DEADLINE]: async f => f.socket('/storage') // never subscribes; deadline below
};
describe('realtime: a cause code and a counter on every server-side disconnect', function () {
  this.timeout(10000);
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));
  it('RT_CAUSE_COVERAGE: every cause has a scenario, and every scenario names a cause', function () {
    assert.deepEqual(Object.keys(SCENARIOS).sort(), Object.values(CAUSES).sort());
  });
  for (const [cause, scenario] of Object.entries(SCENARIOS)) {
    it('RT_CAUSE ' + cause + ': the socket is closed and counted once under its cause', async function () {
      const f = lab({ deadlineMs: cause === CAUSES.UNAUTHORIZED_DEADLINE ? 30 : 600000 });
      try {
        const s = await scenario(f);
        assert.ok(await until(() => s.disconnected, 2000), 'RT_CAUSE ' + cause + ' the socket was closed');
        await sleep(20);
        const { disconnects } = f.protocol.stats();
        assert.deepEqual(disconnects, { [cause]: 1 }, 'RT_CAUSE ' + cause + ' counted once under its own cause: ' + JSON.stringify(disconnects));
      } finally { f.close(); }
    });
  }
  it('RT_CAUSE_REASON: a refusal records the refusal code; a tenant invalidation records its source', async function () {
    const f = lab();
    try {
      f.ctl.api = 'denied'; await f.socket('/');
      assert.ok(await until(() => f.count(CAUSES.PRIME_REFUSED) === 1, 2000));
      f.ctl.api = 'read'; await f.primed(); f.protocol.invalidateTenant(A, 'activity');
      assert.deepEqual(f.protocol.stats().disconnectReasons, { [CAUSES.PRIME_REFUSED + ':REALTIME_CLIENT_DENIED']: 1, [CAUSES.TENANT_INVALIDATED + ':activity']: 1 });
    } finally { f.close(); }
  });
  it('RT_NO_CAP: 5,000 bound sockets on one process are all kept; a protocol given maxSockets refuses to start', async function () {
    const f = lab();
    try {
      f.ctl.api = 'unavailable'; // stay unprimed: binding cost only
      const sockets = await Promise.all(Array.from({ length: 5000 }, () => f.socket('/')));
      assert.equal(sockets.filter(s => s.disconnected).length, 0);
      assert.equal(f.protocol.stats().sockets, 5000);
      assert.throws(() => protocolFactory.create({ admission: { resolve () {} }, api: { authorizeSocket () {}, executeSocketMutation () {} }, readCurrent () {}, runtime () {}, domains: [], maxSockets: 10 }),
        /no per-process socket cap/);
    } finally { f.close(); }
  });
});
describe('realtime: the unauthorized-socket deadline', function () {
  this.timeout(10000);
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));
  it('RT_DEADLINE_IDLE: a socket that never authorizes is closed at the deadline; an answered socket without read is kept', async function () {
    const f = lab({ deadlineMs: 40 });
    try {
      const idle = await f.socket('/storage');
      f.ctl.api = 'noread'; const answered = await f.socket('/'); // the stock web client re-sends authorize on this socket after sign-in
      assert.ok(await until(() => idle.disconnected, 1000), 'RT_DEADLINE_IDLE the idle socket was closed');
      await sleep(200);
      assert.equal(answered.disconnected, undefined, 'RT_DEADLINE_ANSWERED an answered socket is kept');
      assert.ok(answered.sent.some(row => row.event === 'connected'), 'the answered socket was told it connected');
      assert.deepEqual(f.protocol.stats().disconnects, { [CAUSES.UNAUTHORIZED_DEADLINE]: 1 });
    } finally { f.close(); }
  });
  it('RT_DEADLINE_NOT_READY: a socket whose authorization waits on a not-ready api is never closed by the deadline, and primes when the api answers', async function () {
    const f = lab({ deadlineMs: 30 });
    try {
      f.ctl.api = 'unavailable';
      const main = await f.socket('/'), storage = await f.socket('/storage'); storage.receive('subscribe', {});
      await sleep(400); // more than ten deadlines
      assert.equal(main.disconnected, undefined, 'RT_DEADLINE_NOT_READY main socket kept while the api is not ready');
      assert.equal(storage.disconnected, undefined, 'RT_DEADLINE_NOT_READY storage socket kept while the api is not ready');
      assert.ok(f.protocol.stats().deadlineDeferred >= 2, 'the deadline fired and was re-armed: ' + f.protocol.stats().deadlineDeferred);
      f.ctl.api = 'read';
      assert.ok(await until(() => main.sent.some(row => row.event === 'dataUpdate'), 2000), 'primes once the api answers');
      await sleep(100);
      assert.equal(main.disconnected, undefined); assert.equal(storage.disconnected, undefined);
      assert.deepEqual(f.protocol.stats().disconnects, {});
    } finally { f.close(); }
  });
});
describe('realtime: nothing tenant-scoped reaches an unauthorized socket', function () {
  this.timeout(10000);
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));
  it('RT_NO_FRAME_UNAUTHORIZED: fanout, alarm and recheck send nothing to sockets awaiting authorization; the same sockets get data once authorized', async function () {
    const f = lab();
    try {
      f.ctl.api = 'unavailable';
      const main = await f.socket('/'), storage = await f.socket('/storage'), alarm = await f.socket('/alarm');
      storage.receive('subscribe', {}); alarm.receive('subscribe', {});
      await sleep(50);
      await f.protocol.fanout({ tenant: A, previous: f.ctl.frame, next: frameOf(2) });
      await f.protocol.alarm({ tenant: A, notification: { level: 2 } });
      await f.protocol.recheckTenant(A);
      await sleep(50);
      for (const [name, s] of Object.entries({ main, storage, alarm })) {
        assert.deepEqual(s.sent, [], 'RT_NO_FRAME_UNAUTHORIZED ' + name + ' received ' + JSON.stringify(s.sent.map(row => row.event)));
        assert.equal(s.disconnected, undefined);
      }
      // Positive control: the same sockets are reachable once authorized.
      f.ctl.api = 'read';
      assert.ok(await until(() => main.sent.some(row => row.event === 'dataUpdate'), 2000), 'main socket primes once the api answers');
      assert.ok(await until(() => f.protocol.stats().primed === 3, 2000), 'all three primed');
      await f.protocol.alarm({ tenant: A, notification: { level: 2 } });
      assert.ok(alarm.sent.some(row => row.event === 'urgent_alarm'), 'the authorized alarm socket receives the alarm');
    } finally { f.close(); }
  });
});
