'use strict';

// Logical request lifetime over the actual realtime protocol. Fake time and
// recording ports only: no Socket.IO listener, database, provider or timer sleep.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const protocolFactory = require('../lib/server/realtime/protocol');
const A = '55555555-5555-4555-8555-555555555555';
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function deferred () {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
class Clock {
  constructor () {
    this.at = 0; this.timers = new Map(); this.sequence = 0;
    this.set = this.set.bind(this); this.clear = this.clear.bind(this);
  }
  set (fn, delay) {
    const id = { sequence: ++this.sequence, unref () {} };
    this.timers.set(id, { fn, at: this.at + delay });
    return id;
  }
  clear (id) { return this.timers.delete(id); }
  async advance (to) {
    let work = 0;
    for (;;) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      assert(++work < 1000, 'fake-clock work stays bounded');
      this.at = due[1].at; this.timers.delete(due[0]); due[1].fn(); await flush();
    }
    this.at = to; await flush();
  }
}
class Socket extends EventEmitter {
  constructor () {
    super(); this.id = 'synthetic'; this.rooms = new Set([this.id]); this.sent = []; this.connected = true;
    this.request = { headers: { host: 'synthetic.invalid' }, rawHeaders: ['Host', 'synthetic.invalid'], socket: {} };
    this.joinGate = null;
  }
  emit (event, value) { this.sent.push({ event, value }); return true; }
  receive (event, ...args) { return Promise.all(this.listeners(event).map(fn => fn(...args))); }
  // The default adapter applies membership synchronously; a gate holds only
  // the completion await. This does not model a distributed adapter contract.
  join (room) { this.rooms.add(room); return this.joinGate?.promise; }
  leave (room) { this.rooms.delete(room); }
  disconnect () { this.connected = false; EventEmitter.prototype.emit.call(this, 'disconnect', 'io server disconnect'); }
  clientClose () { this.connected = false; EventEmitter.prototype.emit.call(this, 'disconnect', 'transport close'); }
}
function observe (promise) {
  const result = { settled: 0, rejected: 0 };
  result.promise = Promise.resolve(promise).then(() => { result.settled++; }, error => { result.rejected++; result.error = error; });
  return result;
}
function fixture ({ warm = true, freshFails = false, authorize } = {}) {
  const clock = new Clock(), requests = [], releases = [];
  const frame = { identity: 'current', frame: { lastUpdated: 0, sgvs: [] }, rows: [] };
  const control = { warm, freshFails, freshGate: null, readNextGate: null };
  const rights = read => ({ permissions: { read, write: false, write_treatment: false, ack: false }, collections: ['entries', 'treatments'] });
  const runtime = {
    warm: () => control.warm,
    wake () {},
    last: () => frame,
    async fresh () {
      if (control.freshGate) await control.freshGate.promise;
      if (control.freshFails) throw Object.assign(new Error('synthetic refresh unavailable'), { code: 'REALTIME_TENANT_NOT_WARM' });
      return frame;
    }
  };
  const protocol = protocolFactory.create({
    admission: { resolve: async () => A },
    api: { authorizeSocket: async request => { requests.push(request); return authorize ? authorize(request, rights) : rights(true); }, executeSocketMutation: async () => ({}) },
    readCurrent: async () => {
      const gate = control.readNextGate; control.readNextGate = null;
      if (gate) await gate.promise;
      return { identity: 'current' };
    }, runtime: () => runtime, domains: ['entries', 'treatments'],
    now: () => clock.at, setTimer: clock.set, clearTimer: clock.clear, retry: { minMs: 500, maxMs: 2000 }
  });
  return {
    clock, protocol, control, requests, releases, rights,
    async socket (namespace = '/') { const socket = new Socket(); await protocol.prepare(socket); protocol.bind(socket, namespace); await flush(); return socket; },
    start (socket, message, event = 'authorize') {
      const callbacks = [];
      const result = observe(socket.receive(event, message, value => callbacks.push(value)));
      result.callbacks = callbacks;
      return result;
    },
    hold () { const gate = deferred(); releases.push(gate); return gate; },
    frames: socket => socket.sent.filter(row => row.event === 'dataUpdate'),
    async close () { for (const gate of releases) gate.resolve(); protocol.close(); await flush(); }
  };
}

describe('realtime logical request lifetime', function () {
  this.timeout(10000);
  it('keeps one periodic authority sweep when a socket binds during a recheck', async function () {
    let gate;
    const f = fixture({ authorize: async (_request, rights) => {
      if (gate) await gate.promise;
      return rights(true);
    } });
    try {
      const socket = await f.socket('/storage');
      await f.start(socket, { accessToken: 'synthetic-current' }, 'subscribe').promise;
      assert.equal(f.protocol.stats().primed, 1);
      const interval = protocolFactory.DEFAULT_RECHECK_MS;
      gate = f.hold();
      await f.clock.advance(interval);
      assert.equal(f.requests.length, 2, 'subscription and first periodic recheck');
      await f.socket('/storage');
      gate.resolve(); await flush();
      await f.clock.advance(2 * interval);
      assert.equal(f.requests.length, 3, 'only the original sweep rechecks the subscribed socket');
    } finally { await f.close(); }
  });

  for (const mode of ['cold park', 'fresh failure']) {
    it('keeps a successful authority request pending through repeated ' + mode + ', then delivers once', async function () {
      const f = fixture({ warm: mode !== 'cold park', freshFails: mode === 'fresh failure' });
      try {
        const socket = await f.socket(); socket.sent.length = 0;
        const request = f.start(socket, { token: 'synthetic-current' }); await flush();
        // The bind-time anonymous request may already have armed a retry.
        // Cross that retry so this explicit credential has actually answered.
        await f.clock.advance(1000);
        assert.equal(request.settled, 0, 'accepted authority is still awaiting a frame');
        assert.equal(f.protocol.stats().queued, 1);
        assert.equal(f.protocol.watched(A), true, 'pending demand remains registered');
        const initialCalls = f.requests.length;
        await f.clock.advance(2000);
        assert.equal(f.requests.length, initialCalls, 'short retries reuse the current authority answer');
        await f.clock.advance(60001);
        assert.equal(socket.connected, true, 'pending work is not an unauthorized idle socket');
        assert.equal(request.settled, 0);
        assert.equal(f.protocol.watched(A), true);
        assert.equal(f.frames(socket).length, 0);
        assert(f.protocol.stats().deadlineDeferred >= 1);
        assert.deepEqual(f.protocol.stats().disconnects, {});
        assert(f.requests.length > initialCalls, 'long retries recheck authority instead of retaining it indefinitely');
        assert(f.protocol.stats().primeRetries < 200, 'retry work remains bounded');
        f.control.warm = true; f.control.freshFails = false; f.protocol.tenantReady(A); await flush();
        assert.equal(request.settled, 1); assert.equal(request.rejected, 0); assert.equal(request.callbacks.length, 1);
        assert.equal(f.frames(socket).length, 1); assert.equal(f.protocol.stats().queued, 0);
        await f.clock.advance(61001);
        assert.equal(request.settled, 1); assert.equal(request.callbacks.length, 1); assert.equal(f.frames(socket).length, 1);
      } finally { await f.close(); }
    });
  }

  for (const phase of ['pending', 'authority in flight']) {
    it('supersedes the old ' + phase + ' request without its callback or frame', async function () {
      let gate;
      const f = fixture({ warm: phase !== 'pending', authorize: (request, rights) => request.credential.token === 'synthetic-old' && phase !== 'pending' ? gate.promise : rights(true) });
      gate = f.hold();
      try {
        const socket = await f.socket(); socket.sent.length = 0;
        const old = f.start(socket, { token: 'synthetic-old' }); await flush();
        if (phase === 'pending') await f.clock.advance(1000);
        assert.equal(old.settled, 0, 'the old request has not completed before supersession');
        f.control.warm = false;
        const current = f.start(socket, { token: 'synthetic-new' }); await flush();
        assert.equal(old.settled, 1, 'supersession settles even an outstanding authority await');
        assert.equal(old.callbacks.length, 0); assert.equal(f.frames(socket).length, 0);
        assert.equal(current.settled, 0);
        gate.resolve(f.rights(true)); await flush();
        await f.clock.advance(60001);
        assert.equal(current.settled, 0);
        assert.equal(f.protocol.watched(A), true, 'late old completion cannot consume the replacement pending interest');
        assert.equal(socket.connected, true);
        f.control.warm = true; f.protocol.tenantReady(A); await flush();
        assert.equal(old.settled, 1); assert.equal(old.rejected, 0); assert.equal(old.callbacks.length, 0);
        assert.equal(current.settled, 1); assert.equal(current.callbacks.length, 1);
        assert.equal(f.frames(socket).length, 1); assert.equal(f.protocol.stats().queued, 0);
      } finally { await f.close(); }
    });
  }

  for (const phase of ['pending', 'authority in flight']) {
    for (const cancellation of ['close', 'disconnect', 'invalidation']) {
      it(cancellation + ' settles a ' + phase + ' request before a late authority answer', async function () {
        let gate;
        const f = fixture({ warm: phase !== 'pending', authorize: (request, rights) => request.credential.token === 'synthetic-held' && phase !== 'pending' ? gate.promise : rights(true) });
        gate = f.hold();
        try {
          const socket = await f.socket(); socket.sent.length = 0;
          const request = f.start(socket, { token: 'synthetic-held' }); await flush();
          if (phase === 'pending') await f.clock.advance(1000);
          assert.equal(request.settled, 0, 'request is still pending before cancellation');
          if (cancellation === 'close') f.protocol.close();
          else if (cancellation === 'disconnect') socket.clientClose();
          else f.protocol.invalidateTenant(A, 'synthetic-lifecycle');
          await flush();
          assert.equal(request.settled, 1, 'logical cancellation does not wait for a physical authority answer');
          assert.equal(request.rejected, 0); assert.equal(request.callbacks.length, 0);
          assert.equal(f.protocol.stats().queued, 0); assert.equal(f.protocol.watched(A), false);
          gate.resolve(f.rights(true)); await flush(); await f.clock.advance(120001);
          assert.equal(request.settled, 1); assert.equal(request.callbacks.length, 0);
          assert.equal(f.frames(socket).length, 0); assert.equal(f.protocol.stats().queued, 0);
          assert.equal(f.protocol.watched(A), false, 'late completion cannot restore canceled interest');
          assert.equal(f.protocol.stats().disconnects[protocolFactory.CAUSES.UNAUTHORIZED_DEADLINE] || 0, 0);
        } finally { await f.close(); }
      });
    }
  }

  for (const phase of ['authority in flight', 'join in flight']) {
    it('a second storage subscription supersedes the first with ' + phase, async function () {
      let gate;
      const f = fixture({ authorize: (request, rights) => request.credential.accessToken === 'synthetic-old' && phase === 'authority in flight' ? gate.promise : rights(true) });
      gate = f.hold();
      try {
        const socket = await f.socket('/storage');
        if (phase === 'join in flight') socket.joinGate = gate;
        const old = f.start(socket, { accessToken: 'synthetic-old', collections: ['entries', 'treatments'] }, 'subscribe'); await flush();
        assert.equal(old.settled, 0);
        const current = f.start(socket, { accessToken: 'synthetic-new', collections: ['entries'] }, 'subscribe'); await flush();
        assert.equal(old.settled, 1, 'new subscription ends the previous logical request');
        assert.equal(old.callbacks.length, 0); assert.equal(current.settled, 0);
        socket.joinGate = null; gate.resolve(f.rights(true)); await flush();
        assert.equal(old.settled, 1); assert.equal(old.callbacks.length, 0);
        assert.equal(current.settled, 1); assert.deepEqual(current.callbacks, [{ success: true, collections: ['entries'] }]);
        assert.equal(socket.rooms.has(protocolFactory.room(A, '/storage', 'entries')), true);
        assert.equal(socket.rooms.has(protocolFactory.room(A, '/storage', 'treatments')), false, 'superseded join loop never adds its next excluded collection');
        assert.equal(f.frames(socket).length, 0); assert.equal(f.protocol.stats().queued, 0);
      } finally { await f.close(); }
    });
  }

  it('supersedes a held same-revision resend when a newer permission recheck queues another', async function () {
    let phase = 0, holdNext = false, gate, f;
    f = fixture({ authorize: (_request, rights) => {
      const current = rights(true); current.permissions.ack = phase % 2 === 1;
      if (holdNext) { holdNext = false; f.control.readNextGate = gate; }
      return current;
    } });
    gate = f.hold();
    try {
      const socket = await f.socket(); socket.sent.length = 0;
      phase = 1; holdNext = true;
      await f.protocol.recheckTenant(A); await flush();
      assert.equal(f.control.readNextGate, null, 'the first resend entered its held configuration read');
      assert.equal(f.frames(socket).length, 0);
      phase = 2; await f.protocol.recheckTenant(A); await flush();
      assert.equal(f.frames(socket).length, 0, 'neither pending resend has emitted a frame');
      gate.resolve(); await flush();
      assert.equal(f.frames(socket).length, 1, 'only the current logical resend may publish');
      assert.equal(socket.connected, true); assert.equal(f.protocol.stats().queued, 0);
      assert.deepEqual(f.protocol.stats().disconnects, {});
    } finally { await f.close(); }
  });

  it('a never-subscribed storage socket still expires, while an answered main socket without read stays connected', async function () {
    const f = fixture({ authorize: (_request, rights) => rights(false) });
    try {
      const idle = await f.socket('/storage');
      const answered = await f.socket(); const request = f.start(answered, {}); await flush();
      assert.equal(request.settled, 1); assert.equal(request.callbacks.length, 1);
      assert.equal(f.frames(answered).length, 0);
      await f.clock.advance(59999); assert.equal(idle.connected, true);
      await f.clock.advance(60000);
      assert.equal(idle.connected, false); assert.equal(answered.connected, true);
      assert.deepEqual(f.protocol.stats().disconnects, { [protocolFactory.CAUSES.UNAUTHORIZED_DEADLINE]: 1 });
    } finally { await f.close(); }
  });

  it('an unavailable authority retains the original retry until recovery', async function () {
    let available = false;
    const f = fixture({ authorize: (_request, rights) => {
      if (!available) throw Object.assign(new Error('synthetic authority unavailable'), { code: 'REALTIME_API_UNAVAILABLE' });
      return rights(true);
    } });
    try {
      const socket = await f.socket(); const request = f.start(socket, { token: 'synthetic-current' }); await flush();
      await f.clock.advance(60001);
      assert.equal(socket.connected, true); assert.equal(request.settled, 0); assert.equal(f.protocol.watched(A), true);
      assert(f.protocol.stats().deadlineDeferred >= 1); assert.deepEqual(f.protocol.stats().disconnects, {});
      available = true; f.protocol.tenantReady(A); await flush();
      assert.equal(request.settled, 1); assert.equal(request.callbacks.length, 1); assert.equal(f.frames(socket).length, 1);
    } finally { await f.close(); }
  });

  for (const denial of ['denied answer', 'credential refusal']) {
    it('keeps the actual ' + denial + ' terminal and counted once', async function () {
      const f = fixture({ authorize: () => {
        if (denial === 'denied answer') return { denied: true };
        throw Object.assign(new Error('synthetic credential refused'), { code: 'SOCKET_CREDENTIAL_REFUSED' });
      } });
      try {
        const socket = await f.socket('/storage'); const request = f.start(socket, { accessToken: 'synthetic-denied' }, 'subscribe'); await flush();
        assert.equal(socket.connected, false); assert.equal(request.settled, 1); assert.equal(request.callbacks.length, 1);
        assert.equal(request.callbacks[0].success, false); assert.equal(f.frames(socket).length, 0);
        await f.clock.advance(120001);
        assert.deepEqual(f.protocol.stats().disconnects, { [protocolFactory.CAUSES.PRIME_REFUSED]: 1 });
        assert.equal(f.protocol.stats().queued, 0); assert.equal(f.protocol.watched(A), false);
      } finally { await f.close(); }
    });
  }

  it('keeps interest empty when transport disconnect arrives after protocol close', async function () {
    for (const read of [true, false]) {
      const f = fixture({ authorize: (_request, rights) => rights(read) });
      try {
        const socket = await f.socket();
        const request = f.start(socket, { token: 'synthetic-current' }); await flush();
        assert.equal(request.settled, 1, 'the request has already finished before shutdown');
        assert.equal(f.protocol.watchedCount(), 1);
        f.protocol.close();
        assert.equal(f.protocol.watchedCount(), 0);
        socket.clientClose(); socket.clientClose(); await flush();
        assert.equal(f.protocol.watchedCount(), 0, 'late transport callbacks cannot recreate cleared interest');
        assert.equal(f.protocol.watched(A), false);
        assert.equal(f.protocol.stats().queued, 0);
        await f.clock.advance(120001);
        assert.equal(f.protocol.watchedCount(), 0);
      } finally { await f.close(); }
    }
  });

  it('preserves an answered alarm subscription and its current-authority delivery', async function () {
    const f = fixture();
    try {
      const socket = await f.socket('/alarm');
      const request = f.start(socket, { accessToken: 'synthetic-alarm' }, 'subscribe'); await flush();
      assert.equal(request.settled, 1); assert.equal(request.callbacks.length, 1); assert.equal(request.callbacks[0].success, true);
      await f.clock.advance(60001);
      assert.equal(socket.connected, true); assert.deepEqual(f.protocol.stats().disconnects, {});
      const accepted = await f.protocol.alarm({ tenant: A, notification: { level: 2 } });
      assert.equal(accepted.accepted, true); assert.equal(socket.sent.filter(row => row.event === 'urgent_alarm').length, 1);
      assert.equal(f.frames(socket).length, 0);
    } finally { await f.close(); }
  });
});
