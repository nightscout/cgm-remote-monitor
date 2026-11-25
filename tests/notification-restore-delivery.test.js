'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const openAlarmSubscriber = require('./fixtures/notification-alarm-subscriber');
const scope = require('../lib/storage/tenant-scope');
const createStore = require('../lib/tenant-notifications/postgres');
const createNotifier = require('../lib/tenant-notifications/component');
const alarms = require('../lib/server/realtime/alarm-transport');
const privateTransport = require('../lib/server/internal-api/transport');
const { alarmDelivery } = require('../lib/server/internal-api/contracts');
const fixture = require('./fixtures/tenant-notifications');

// Recording SQL, a real private Unix socket, and a stock polling Socket.IO
// client. The transport callback and the subscriber event are separate oracles.
describe('queued clinical alarm across a lifecycle generation change', function () {
  this.timeout(15000);
  let prior;
  beforeEach(() => { prior = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(prior));

  async function observe (handoffPayload = value => value, legacy = false) {
    const f = fixture();
    let generation = '17', current = false, suppressed = false;
    const store = createStore({ connection: f.connection, namespace: 'notification_test',
      currentGeneration: () => generation, maxRows: 10, maxBytes: 65536 });
    const input = { tenant: f.A, consumer: 'realtime-preview', key: 'realtime-cycle:synthetic-alarm',
      configIdentity: 'before', origin: 'synthetic-alarm-transition', payload: fixture.notification({ level: 2 }),
      at: f.now(), normalPolicy: 'realtime-cycle' };
    const writer = legacy ? f.store : store;
    const request = await scope.withTenant(f.A, () => writer.enqueue(input));
    const origin = legacy ? undefined : '17';
    assert.equal(request.payload.originGeneration, origin);

    // The new producer has a different clinical view, with no alarm. Its normal
    // stale-intent retirement must leave this committed delivery obligation.
    generation = '18';
    const selected = await scope.withTenant(f.A, () => store.consume({tenant: f.A, consumer: input.consumer,
      transform: async () => ({ configIdentity: 'after', producer: {}, retireObsolete: true, intents: [] })}));
    assert.deepEqual(selected.preserved, [request.request_id]);
    assert.equal(f.snapshot().requests[0].state, 'pending');
    const frozen = await scope.withTenant(f.A, () => store.enqueue({...input, payload: fixture.notification({ level: 1 })}));
    assert.notEqual(frozen.request_id, request.request_id);
    assert.equal(frozen.payload.originGeneration, '18');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-alarm-origin-'));
    const endpoint = { socketPath: path.join(dir, 'alarm.sock'), timeoutMs: 2000, maxBytes: 65536 };
    let audience, ipc, notifier;
    const wireAttempts = [];
    try {
      audience = await openAlarmSubscriber(f.A);
      ipc = await privateTransport.open(endpoint, alarmDelivery, token => {
        const route = alarms.operations({ token, deliver: audience.deliver });
        return { async deliverAlarm (context, body) {
          wireAttempts.push({id: body.id, attempt: body.attempt});
          // First attempt is uncertain, before delivery. A later transport
          // acknowledgment must refer to this same durable request.
          if (wireAttempts.length === 1) throw new Error('synthetic transport unavailable');
          return route.deliverAlarm(context, { ...body, notification: handoffPayload(body.notification) });
        } };
      });
      notifier = createNotifier({ ...f.hooks, store, adapter: alarms.createAdapter(endpoint),
        normalPolicy: 'realtime-cycle', currentAuthority: async tenant => tenant === f.A && current,
        allows: async () => !suppressed, mayAttempt: async () => false,
        selectCycle: async () => { throw new Error('restored output cannot reconstruct the original alarm'); } });

      const retry = async () => (await notifier.retry(f.A)).results.find(row => row.id === request.request_id);
      assert.deepEqual(await retry(), { id: request.request_id, state: 'deferred' });
      assert.equal(wireAttempts.length, 0);
      f.advance(31); current = true; suppressed = true;
      assert.deepEqual(await retry(), { id: request.request_id, state: 'deferred' });
      assert.equal(wireAttempts.length, 0);
      f.advance(31); suppressed = false;
      assert.deepEqual(await retry(), { id: request.request_id, state: 'uncertain' });
      f.advance(31);
      const event = once(audience.subscriber, 'urgent_alarm');
      assert.deepEqual(await retry(), { id: request.request_id, state: 'accepted' });
      const [received] = await event;
      assert.equal(received.originGeneration, origin, 'ALARM_ORIGIN_GENERATION_AT_SUBSCRIBER');
      assert.deepEqual(received, request.payload);
      assert.deepEqual(wireAttempts.map(row => row.id), [request.request_id, request.request_id]);
      assert(wireAttempts[1].attempt > wireAttempts[0].attempt);
      assert.deepEqual((await notifier.retry(f.B)).results, []);
    } finally {
      await notifier?.close(); await ipc?.close(); await audience?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('delivers a queued alarm on its original request after restore and an uncertain handoff', () => observe());
  it('carries an older queued alarm with unknown origin without inventing a generation', () => observe(undefined, true));
  it('invalidates serving state while a committed notification waits for transport acceptance', async () => {
    let enter, complete;
    const entered = new Promise(resolve => { enter = resolve; });
    const f = await require('./fixtures/evaluator-consumers-protocol')((request, callback) => {
      if (request.tenant === f.A) { complete = callback; enter(request.id); }
      else callback(null, { accepted: true });
    });
    try {
      f.consumers.start();
      const id = await entered;
      const old = f.consumers.flush(f.A);
      await f.consumers.flush(f.B);
      const neighbour = f.consumers.health([f.B]);
      let invalidated = false;
      const invalidation = f.consumers.invalidateTenant(f.A).then(() => { invalidated = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(invalidated, true, 'INVALIDATION_MUST_NOT_WAIT_FOR_TRANSPORT_ACCEPTANCE');
      await invalidation;
      const fresh = f.consumers.health([f.A]);
      assert.equal(fresh.tenants[0].state, 'starting');
      const row = () => f.files.get(f.A).snapshot().requests.find(request => request.request_id === id);
      assert.equal(row().state, 'attempting');
      complete(null, { accepted: true });
      await old;
      assert.equal(row().state, 'accepted', 'the accepted attempt retains its durable identity');
      assert.deepEqual(f.consumers.health([f.A]), fresh, 'old handoff completion cannot publish to fresh serving state');
      assert.deepEqual(f.consumers.health([f.B]), neighbour);
    } finally { complete?.(new Error('fixture release')); await f.close(); }
  });
  it('detects metadata lost in the handoff and delivers it again when the handoff is restored', async () => {
    await assert.rejects(observe(notification => {
      const payload = { ...notification };
      delete payload.originGeneration;
      return payload;
    }), /ALARM_ORIGIN_GENERATION_AT_SUBSCRIBER/);
    await observe();
  });
});
