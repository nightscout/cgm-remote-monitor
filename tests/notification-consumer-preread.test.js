'use strict';

// Lane plannable-scale H3, temporary switch NS_CONSUMER_PASS_PREREAD: the
// producer's suppression read and authority/version checks move before the
// outbox transaction where the ACK witness holds; a refused consumer pass is
// counted and logged without tenant ids. Off: unchanged. The ACK race against
// actual PostgreSQL is in tenant-notifications.integration.test.js.
const assert = require('node:assert/strict');
const fixture = require('./fixtures/tenant-notifications');
const producer = require('../lib/tenant-notifications/producer');
const consumers = require('../lib/server/serve/evaluator-consumers');
const scope = require('../lib/storage/tenant-scope');

describe('consumer pass preread (H3 switch)', function () {
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));

  // One producer selection over the SQL-shaped fake. Events record whether the
  // reader, authority check and version read ran inside store.consume.
  async function selection ({ options = {}, seed = null, ackRows = [], clock } = {}) {
    const f = fixture(), events = []; let inside = false, at = f.now();
    if (seed) await scope.withTenant(f.A, () => f.store.consume({ tenant: f.A, consumer: 'h3', transform: async () => seed }));
    f.calls.length = 0;
    const store = { ...f.store, async consume (args) { inside = true; try { return await f.store.consume(args); } finally { inside = false; } } };
    const reader = { async read () { events.push(['read', inside]); return Object.freeze(ackRows.map(row => Object.freeze({ tenant: f.A, ...row }))); } };
    const p = producer({ store, reader, current: async () => null, version: async () => { events.push(['version', inside]); return null; },
      currentConfig: async tenant => ({ tenant, identity: 'config' }), isCurrent: async () => { events.push(['isCurrent', inside]); return true; },
      consumer: 'h3', now: clock ? () => clock(events) : () => at, maxRows: 10, maxBytes: 65536, maxPayloadBytes: 10000, ...options });
    try { await p.select(f.A); } finally { p.close(); }
    return { events, sql: f.calls.map(call => typeof call === 'string' ? call : call.sql), state: f.producerStates()[0]?.producer };
  }
  const seeded = (extra = {}) => ({ configIdentity: 'config', producer: { alarms: [], effects: [], acks: [], output: null, ...extra }, intents: [] });
  const insideOf = events => events.filter(([, inside]) => inside).map(([name]) => name);

  it('off (omitted or false): suppression, authority and version reads stay inside the transaction, with identical SQL', async function () {
    const omitted = await selection({ seed: seeded() }), off = await selection({ seed: seeded(), options: { preread: false } });
    assert.deepEqual(insideOf(omitted.events), ['read', 'isCurrent', 'version'], 'BASE_READS_INSIDE_TRANSACTION');
    assert.deepEqual(off.events, omitted.events, 'SWITCH_OFF_SAME_ORDER');
    assert.deepEqual(off.sql, omitted.sql, 'SWITCH_OFF_SAME_SQL');
  });
  it('on: no read or check waits inside the transaction once the locked state proves no ACK since; same SQL', async function () {
    const off = await selection({ seed: seeded() }), on = await selection({ seed: seeded(), options: { preread: true } });
    assert.deepEqual(insideOf(on.events), [], 'NO_FOREIGN_POOL_WAIT_IN_OUTBOX_TRANSACTION');
    assert.deepEqual(on.events.map(([name]) => name), ['isCurrent', 'read', 'isCurrent', 'version', 'isCurrent', 'version']);
    assert.deepEqual(on.sql, off.sql, 'SAME_OUTBOX_STATEMENTS');
    assert.deepEqual(on.state, off.state, 'SAME_COMMITTED_STATE');
  });
  it('on: an ackPending mark or a missing state row reads and checks again under the lock', async function () {
    const pending = await selection({ seed: seeded({ ackPending: true }), options: { preread: true } });
    assert.deepEqual(insideOf(pending.events), ['read', 'isCurrent', 'version'], 'ACK_PENDING_READS_UNDER_LOCK');
    assert.equal(pending.state.ackPending, undefined, 'mark consumed by the pass that read under the lock');
    const first = await selection({ options: { preread: true } });
    assert.deepEqual(insideOf(first.events), ['read', 'isCurrent', 'version'], 'FIRST_PASS_READS_UNDER_LOCK');
  });
  it('on: ACKs read early are filtered at the transaction time exactly as the reader filters them', async function () {
    // The pre-read runs at T and sees an ACK expiring at T+5; the time sampled
    // under the lock is T+10, where the reader itself would no longer return it.
    const T = 1000000; let calls = 0;
    const kept = { group: 'default', level: 1, ackedAt: T - 100, expiresAt: T + 60000 };
    const on = await selection({ seed: seeded(), options: { preread: true }, clock: () => (calls++ === 0 ? T : T + 10),
      ackRows: [{ group: 'default', level: 2, ackedAt: T - 100, expiresAt: T + 5 }, kept] });
    assert.deepEqual(on.state.acks, [JSON.stringify([kept.group, kept.level, kept.ackedAt, kept.expiresAt])], 'EXPIRED_EARLY_ACK_DROPPED');
  });

  it('switch parses true/false/unset and refuses anything else', function () {
    const key = consumers.PREREAD_KEY;
    assert.equal(consumers.prereadSwitch({}), false);
    assert.equal(consumers.prereadSwitch({ [key]: 'false' }), false);
    assert.equal(consumers.prereadSwitch({ [key]: ' TRUE ' }), true);
    assert.throws(() => consumers.prereadSwitch({ [key]: '1' }), /NS_CONSUMER_PASS_PREREAD/);
  });
  it('refusal codes are bounded constants, never free text', function () {
    assert.equal(consumers.refusalCode(Object.assign(new Error('x'), { code: 'STORAGE_BUSY' })), 'STORAGE_BUSY');
    assert.equal(consumers.refusalCode(new Error('NOTIFICATION_PRODUCER_STALE')), 'NOTIFICATION_PRODUCER_STALE');
    assert.equal(consumers.refusalCode(new Error('timeout exceeded when trying to connect')), 'POOL_CHECKOUT_TIMEOUT');
    assert.equal(consumers.refusalCode(Object.assign(new Error('canceling statement'), { code: '57014' })), 'SQLSTATE_57014');
    assert.equal(consumers.refusalCode(new Error('tenant 11111111-1111-4111-8111-111111111111 failed')), 'OTHER');
  });

  it('the coordinator prereads only with the ACK witness (discovery catalogue); without it the reads stay under the lock', async function () {
    async function pass (ackWitness) {
      const f = fixture(), seen = []; let inside = false;
      await scope.withTenant(f.A, () => f.store.consume({ tenant: f.A, consumer: 'h3', transform: async () => seeded() }));
      const store = { ...f.store, async consume (args) { inside = true; try { return await f.store.consume(args); } finally { inside = false; } } };
      const value = consumers.coordinate({ tenants: [f.A], route: 'h3', current: async () => null, currentConfig: async tenant => ({ tenant, identity: 'config' }),
        isCurrent: async () => true, store, reader: { read: async () => { seen.push(inside); return []; }, allows: async () => true },
        adapter: { id: 'h3', send: (row, callback) => callback(null, { accepted: true }) }, schedule: () => 0, cancel: () => {},
        pollIntervalMs: 1000, retryIntervalMs: 1000, maxRows: 10, maxBytes: 65536, maxPayloadBytes: 10000, maxInflight: 1, attemptTimeoutMs: 1000, retryDelayMs: 1,
        preread: true, ackWitness, refusalLogger: () => {} });
      try { value.start(); await value.flush(f.A); return seen; } finally { await value.close(); }
    }
    assert.deepEqual(await pass(false), [true], 'NO_WITNESS_READS_UNDER_LOCK');
    assert.deepEqual(await pass(true), [false], 'WITNESS_PREREADS');
  });

  // A coordinator whose every producer pass is refused at checkout.
  async function refusedPasses (preread, passes) {
    const f = fixture(), lines = []; let t = 5000000;
    const busy = Object.assign(new Error('PostgreSQL connection pool had no free client in time; nothing was written'), { code: 'STORAGE_BUSY' });
    const value = consumers.coordinate({ tenants: [f.A], route: 'h3', current: async () => null, currentConfig: async tenant => ({ tenant, identity: 'config' }),
      isCurrent: async () => true, store: { ...f.store, consume: async () => { throw busy; } }, reader: { read: async () => [], allows: async () => true },
      adapter: { id: 'h3', send: (row, callback) => callback(null, { accepted: true }) }, now: () => t,
      schedule: () => 0, cancel: () => {}, pollIntervalMs: 1000, retryIntervalMs: 1000, maxRows: 10, maxBytes: 65536, maxPayloadBytes: 10000,
      maxInflight: 1, attemptTimeoutMs: 1000, retryDelayMs: 1, preread, ackWitness: true, refusalLogger: line => lines.push(line) });
    try {
      value.start(); await value.flush(f.A);
      for (let i = 1; i < passes; i++) { if (i === passes - 1) t += 10000; await value.hint(f.A); await value.flush(f.A); }
      return { health: value.health(), lines };
    } finally { await value.close(); }
  }
  it('on: refused passes are counted by code and logged at most once per 10 s without tenant ids; off: neither', async function () {
    const on = await refusedPasses(true, 4);
    assert.equal(on.health.tenants[0].code, 'EVALUATOR_CONSUMER_REFUSED');
    assert.equal(on.health.refusals, 4, 'REFUSALS_COUNTED');
    assert.deepEqual(on.health.refusalCodes, { STORAGE_BUSY: 4 });
    assert.equal(on.lines.length, 2, 'REFUSAL_LOG_BOUNDED');
    assert.match(on.lines[0], /STORAGE_BUSY=1 \(total 1\)/); assert.match(on.lines[1], /STORAGE_BUSY=3 \(total 4\)/);
    assert(on.lines.every(line => !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(line)), 'NO_TENANT_ID_IN_LOG');
    const off = await refusedPasses(false, 4);
    assert.equal(off.health.tenants[0].code, 'EVALUATOR_CONSUMER_REFUSED');
    assert.equal(off.lines.length, 0); assert.equal('refusals' in off.health, false, 'SWITCH_OFF_HEALTH_UNCHANGED');
  });
});
