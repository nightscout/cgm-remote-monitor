'use strict';
const assert = require('node:assert/strict');
const { A, B, I, placement, config, parse, move } = require('./fixtures/realtime-placement-map');
describe('registry placement subset selection', function () {
  it('SHARD_ROSTER: warms only assigned tenants, changes subset without a data/registry write, and leaves unchanged polling constant', async function () {
    const C = '33333333-3333-4333-8333-333333333333';
    let revision = '1', selected = new Set([A]), generation = 1, enumerations = 0, predicates = 0;
    const ids = [A, B], built = [], activated = [], removed = [];
    const registry = require('../lib/server/serve/registry-tenant-set').create({
      store: { revision: async () => revision, enumerate: async () => { enumerations++; return { revision, tenants: [...ids] }; },
        page: async (after, limit) => ({ tenants: ids.filter(id => after === null || id > after).slice(0, limit) }) },
      first: { revision, tenants: [...ids] }, settings: { namespace: 'synthetic_registry', refreshMs: 100 }, maxTenants: 10,
      build: tenant => { built.push(tenant); return { tenant }; }, accept: tenant => { predicates++; return selected.has(tenant); },
      selectionKey: () => generation, schedule: () => null, cancel () {}, alert () {} });
    try {
      assert.deepEqual(built, [A], 'SHARD_ROSTER unowned B has no initial build');
      await registry.follow({ prepare: async () => () => {}, activate: tenant => activated.push(tenant), remove: async tenant => removed.push(tenant) });
      const before = { enumerations, predicates };
      await registry.poll(); await registry.poll();
      assert.deepEqual({ enumerations, predicates }, before, 'SHARD_ROSTER unchanged ticks do not expand/select roster');
      selected = new Set([B]); generation++;
      await registry.poll(); await registry.drained();
      assert.equal(registry.isActive(A), false); assert.equal(registry.isActive(B), true);
      assert.deepEqual(activated, [B]); assert.deepEqual(removed, [A]); assert.equal(enumerations, before.enumerations, 'placement-only revision reuses bounded known roster');
      ids.push(C); revision = '2'; await registry.poll(); await registry.drained();
      assert.equal(registry.isActive(C), false); assert.ok(!built.includes(C), 'SHARD_ROSTER unowned live-add never builds');
    } finally { await registry.close(); }
  });
});

describe('alarm routing across controlled placement', function () {
  it('SHARD_ALARM: same epoch routes to current owner, stale routing refuses before effect, and uncertainty retains request/attempt without transparent retry', async function () {
    const alarms = require('../lib/server/realtime/alarm-transport'), token = Symbol('transport');
    let map = parse(config()), effects = 0;
    const reader = placement.create({ read: () => map, self: { worker: 'a', incarnation: I } });
    const sink = alarms.operations({ token, placement: reader, deliver: async () => { effects++; } });
    const routes = [], bodies = []; let lost = false;
    const adapter = alarms.createPlacementAdapter({ placement: reader, clientFor: endpoint => ({ deliverAlarm: async body => {
      routes.push(endpoint); bodies.push(body);
      if (lost) throw new Error('response lost');
      return sink.deliverAlarm({ transport: token }, body);
    } }) });
    const input = { tenant: A, id: B, attempt: 3, notification: { title: 'synthetic' }, receipts: [] };
    const send = () => new Promise((resolve, reject) => adapter.send(input, (error, value) => error ? reject(error) : resolve(value)));
    assert.deepEqual(await send(), { accepted: true, receipt: null, clearedRequestIds: [] }); assert.equal(effects, 1);
    const old = structuredClone(bodies[0]);
    map = parse(move(config(), 'b'));
    await assert.rejects(sink.deliverAlarm({ transport: token }, old), { code: 'REALTIME_PLACEMENT_WRONG_OWNER' }); assert.equal(effects, 1);
    lost = true; await assert.rejects(send(), /REALTIME_HANDOFF_UNAVAILABLE/);
    assert.equal(bodies.length, 2, 'SHARD_ALARM no transparent retry on uncertainty');
    assert.equal(bodies[1].id, input.id); assert.equal(bodies[1].attempt, input.attempt); assert.deepEqual(bodies[1].notification, input.notification);
    assert.equal(routes[1].socketPath, '/tmp/shard-b.sock'); assert.equal(bodies[1].placement.generation, 2);
  });
});

describe('quiet target startup admission', function () {
  it('SHARD_PAUSED_WARM: skips protected initialization for paused/suspended targets, inspects idle state and returns to eligible without a fake successful warm', async function () {
    const initialized = [], alerts = [], eligible = new Set([B]); let at = 0;
    const startup = require('../lib/server/serve/tenant-startup').create([A, B], undefined, async tenant => initialized.push(tenant),
      { readiness: 'all', eligible: async tenant => eligible.has(tenant), now: () => at, coldAlertMs: 100, alert: (...args) => alerts.push(args) });
    try {
      assert.deepEqual(await startup.warm(), [false, true]); assert.deepEqual(initialized, [B], 'SHARD_PAUSED_WARM no paused initialization');
      assert.equal(startup.isReady(A), false); assert.equal(startup.health().deferred, 1); assert.equal(startup.isReady(B), true);
      at = 1000; await new Promise(resolve => setTimeout(resolve, 300)); assert.deepEqual(alerts, []);
      eligible.add(A); await startup.ensure(A); assert.equal(startup.isReady(A), true); assert.deepEqual(initialized, [B, A]);
    } finally { startup.close(); }
  });
  it('SHARD_DEFER_BRAND: application errors with a matching code still fail initialization', async function () {
    const startup = require('../lib/server/serve/tenant-startup').create([A], undefined,
      async () => { throw Object.assign(new Error('synthetic application failure'), { code: 'TENANT_ACTIVITY_DEFERRED' }); }, { eligible: async () => true });
    try { await assert.rejects(startup.warm(), /synthetic application failure/); } finally { startup.close(); }
  });
});

describe('sharded alarm envelope bound', function () {
  it('reserves the maximum placement tuple only for the selected sharded transport', function () {
    const metadata = require('../lib/server/serve/evaluator-consumer-config').metadata;
    const value = { realtime: { outbox: { connectionEnv: 'OUTBOX', namespace: 'synthetic_outbox', maxRows: 1, maxBytes: 10000, maxConnections: 1 }, suppression: { connectionEnv: 'ALARM', namespace: 'synthetic_alarm', maxRows: 1, maxBytes: 10000, maxConnections: 1 }, route: { id: 'synthetic', maxMessageBytes: 1200, operationTimeoutMs: 100 }, maxPayloadBytes: 1000, maxInflight: 1, attemptTimeoutMs: 100, retryDelayMs: 100, pollIntervalMs: 100, retryIntervalMs: 100 } };
    assert.doesNotThrow(() => metadata(value, {}));
    assert.throws(() => metadata(value, {}, { placement: true }), /invalid/);
    value.realtime.route.maxMessageBytes = 1500;
    assert.doesNotThrow(() => metadata(value, {}, { placement: true }));
  });
});
