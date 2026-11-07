'use strict';

// Source-only tests of the two fields the durable delivery contract (rule 3)
// adds to the logical storage-intent-committed event: `tenant` and `stamp`.
// The recording connection is not PostgreSQL (as tests/tenant-commit-clock.test.js);
// real lock/commit visibility is the integration lane's. Synthetic values only.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const scope = require('../lib/storage/tenant-scope');
const dates = require('../lib/server/srv-dates');
const decorate = require('../lib/storage/postgres-write-clock');
const intent = require('../lib/storage/write-intent');
const { withCommitEvents } = require('../lib/storage/postgres-intent-common');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('storage intent event payload: tenant and stamp', function () {
  let previous;
  beforeEach(function () { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(function () { scope.setTenancyMode(previous); });

  // The recording connection of tests/tenant-commit-clock.test.js, with the
  // tenant it expects as a parameter.
  function fixture (tenant = A, initial = Date.now() + 100000) {
    let floor = initial;
    const calls = [];
    const raw = {
      async transaction (fn) {
        calls.push('BEGIN');
        const before = floor;
        try { const result = await fn(); calls.push('COMMIT'); return result; }
        catch (error) { floor = before; calls.push('ROLLBACK'); throw error; }
      },
      async query (sql, values) {
        calls.push({ sql, values });
        if (sql.startsWith('SELECT')) return { rows: [{ last_stamp: String(floor) }] };
        assert.equal(values[1], tenant);
        assert.equal(values[2], floor);
        floor = values[0];
        return { rowCount: 1 };
      }
    };
    return { connection: decorate(raw, 'clock_test'), calls, floor: () => floor, initial };
  }

  function listen (bus) {
    const events = [];
    bus.on(intent.INTENT_EVENT, event => events.push(event));
    return events;
  }

  // A port whose write allocates `stamps` clock values.
  function port (connection, bus, stamps = 1) {
    return withCommitEvents({
      write: async () => { let last = null; for (let i = 0; i < stamps; i++) last = dates.next(); return { items: [], stamp: last }; },
      settle: () => ({ items: [{ _id: null, identifier: 'synthetic', outcome: 'unchanged' }] })
    }, { connection, bus, logical: 'entries', source: 'v3' });
  }

  it('a decorated write that allocates stamps carries the floor the clock wrote and the bound tenant', async function () {
    const f = fixture();
    const bus = new EventEmitter();
    const events = listen(bus);
    const written = await scope.withTenant(A, () => port(f.connection, bus, 3).write({ op: 'create' }));
    assert.equal(events.length, 1);
    const update = f.calls.find(call => call.sql && call.sql.startsWith('UPDATE'));
    assert.ok(update, 'the clock wrote its floor');
    assert.equal(f.floor(), f.initial + 3);
    assert.equal(events[0].stamp, update.values[0], 'the event stamp is the floor the clock wrote');
    assert.equal(events[0].stamp, f.floor());
    assert.equal(events[0].stamp, written.stamp, 'the last record stamp is the floor');
    assert.equal(events[0].tenant, A);
    assert.deepEqual(Object.keys(events[0]), ['collection', 'source', 'op', 'tenant', 'stamp', 'collapsed', 'records', 'counts']);
    assert.ok(Object.isFrozen(events[0]));
  });

  it('a nested write joins the outer transaction; the one event follows outer COMMIT with the final floor', async function () {
    const f = fixture();
    const bus = new EventEmitter();
    const events = [];
    bus.on(intent.INTENT_EVENT, event => events.push({ event, lastCall: f.calls.at(-1) }));
    await scope.withTenant(A, () => f.connection.transaction(async () => {
      dates.next();
      await port(f.connection, bus).write({ op: 'create' });
      assert.deepEqual(events, [], 'nothing published inside the outer transaction');
    }));
    assert.equal(events.length, 1);
    assert.equal(events[0].lastCall, 'COMMIT');
    assert.equal(f.floor(), f.initial + 2);
    assert.equal(events[0].event.stamp, f.initial + 2);
    assert.equal(events[0].event.tenant, A);
    assert.equal(f.calls.filter(call => call === 'BEGIN').length, 1);
  });

  it('a nested write whose outer transaction allocates again afterwards carries the final floor', async function () {
    const f = fixture();
    const bus = new EventEmitter();
    const events = listen(bus);
    let atResolve;
    await scope.withTenant(A, () => f.connection.transaction(async () => {
      dates.next();
      await port(f.connection, bus).write({ op: 'create' });
      atResolve = f.connection.currentStamp();
      dates.next();
      assert.deepEqual(events, []);
    }));
    assert.equal(atResolve, f.initial + 2, 'the floor when the nested write resolved');
    assert.equal(f.floor(), f.initial + 3, 'the floor the clock wrote');
    assert.equal(events.length, 1);
    assert.equal(events[0].stamp, f.initial + 3, 'the event carries the final floor, not the floor at resolve');
    assert.equal(events[0].tenant, A);
  });

  it('a decorated write that allocates nothing carries stamp null', async function () {
    const f = fixture();
    const bus = new EventEmitter();
    const events = listen(bus);
    await scope.withTenant(A, () => port(f.connection, bus, 0).write({ op: 'create' }));
    assert.equal(events.length, 1);
    assert.strictEqual(events[0].stamp, null);
    assert.equal(events[0].tenant, A);
    assert.equal(f.floor(), f.initial);
    assert.equal(f.calls.some(call => call.sql && call.sql.startsWith('UPDATE')), false);
  });

  it('a settle carries stamp null and opens no transaction', async function () {
    const f = fixture();
    const bus = new EventEmitter();
    const events = listen(bus);
    scope.withTenant(A, () => port(f.connection, bus).settle({ op: 'create' }, {}, 'unchanged', 'synthetic'));
    assert.equal(events.length, 1);
    assert.strictEqual(events[0].stamp, null);
    assert.equal(events[0].tenant, A);
    assert.deepEqual(f.calls, []);
  });

  it('outside any clock transaction currentStamp is null; a retained closed context throws', async function () {
    const f = fixture();
    await scope.withTenant(A, async () => {
      assert.strictEqual(f.connection.currentStamp(), null);
      let resume, continuation;
      await f.connection.transaction(async () => {
        assert.strictEqual(f.connection.currentStamp(), null, 'nothing allocated yet');
        dates.next();
        assert.equal(f.connection.currentStamp(), f.initial + 1);
        continuation = new Promise(resolve => { resume = resolve; }).then(() => {
          assert.throws(() => f.connection.currentStamp(), /closed/);
        });
      });
      resume();
      await continuation;
      assert.strictEqual(f.connection.currentStamp(), null);
    });
  });

  it('the tenant is the binding of each write, never remembered from an earlier one', async function () {
    const bus = new EventEmitter();
    const events = listen(bus);
    const plain = { transaction: fn => fn() };
    const step = port(plain, bus);
    await scope.withTenant(A, () => step.write({ op: 'create' }));
    await scope.withTenant(B, () => step.write({ op: 'create' }));
    assert.deepEqual(events.map(event => event.tenant), [A, B], 'each event carries the tenant bound for its own write');
    assert.deepEqual(events.map(event => event.stamp), [null, null], 'no write clock, no stamp');
  });

  it('the direct path carries the bound tenant and stamp null', async function () {
    const bus = new EventEmitter();
    const events = listen(bus);
    const storage = { findFiltered: async () => [], bulkUpsert: async () => ({}) };
    const step = intent.forCollectionIntent(storage, 'entries', 'v1/internal', { env: {}, bus });
    const doc = () => ({ identifier: 'synthetic-direct', type: 'sgv', sgv: 100, dateString: '2026-11-06T01:00:00+01:00' });
    await scope.withTenant(A, () => step.write({ op: 'create', docs: [doc()] }));
    await scope.withTenant(B, () => step.write({ op: 'create', docs: [doc()] }));
    scope.withTenant(B, () => step.settle({ op: 'create' }, doc(), 'unchanged', 'synthetic'));
    assert.deepEqual(events.map(event => [event.tenant, event.stamp]), [[A, null], [B, null], [B, null]]);
  });

  it('under single tenancy the tenant is null, never a Symbol, and the event round-trips through JSON', async function () {
    scope.setTenancyMode('single');
    const bus = new EventEmitter();
    const events = listen(bus);
    const storage = { findFiltered: async () => [], bulkUpsert: async () => ({}) };
    const step = intent.forCollectionIntent(storage, 'entries', 'v1/internal', { env: {}, bus });
    await step.write({ op: 'create', docs: [{ identifier: 'synthetic-single', type: 'sgv', sgv: 100, dateString: '2026-11-06T01:00:00+01:00' }] });
    const plain = port({ transaction: fn => fn() }, bus);
    await plain.write({ op: 'create' });
    plain.settle({ op: 'create' }, {}, 'unchanged', 'synthetic');
    assert.equal(events.length, 3);
    for (const event of events) {
      assert.strictEqual(event.tenant, null);
      assert.strictEqual(event.stamp, null);
      assert.notEqual(typeof event.tenant, 'symbol');
      const parsed = JSON.parse(JSON.stringify(event));
      assert.deepEqual(Object.keys(parsed), Object.keys(event), 'every field survives JSON (a Symbol would be dropped)');
      assert.strictEqual(parsed.tenant, null);
      assert.strictEqual(parsed.stamp, null);
    }
  });

  it('carries no document contents and no filter beside the two fields', async function () {
    const f = fixture();
    const bus = new EventEmitter();
    const events = listen(bus);
    await scope.withTenant(A, () => port(f.connection, bus).write({ op: 'create', docs: [{ secret: 'd-event-document-content' }],
      target: { filter: { mark: 'd-event-filter-mark' } } }));
    const text = JSON.stringify(events[0]);
    assert.equal(text.includes('d-event-document-content'), false);
    assert.equal(text.includes('d-event-filter-mark'), false);
  });
});
