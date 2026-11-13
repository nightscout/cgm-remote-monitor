'use strict';
// The healthy lost-hint rotation covers the roster once per sweepMs (lib/change-feed/consumer.js).
// What must stay as fresh as before: a hinted tenant (a write, a pause, a settings change) is checked
// on the next tick; a degraded feed rotates full pages; without sweepMs nothing changes.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const consumerFactory = require('../lib/change-feed/consumer');
const parser = require('../lib/change-feed/config');
const tenantsOf = n => Array.from({ length: n }, (_, i) => '10000000-0000-4000-8000-' + i.toString(16).padStart(12, '0'));
const READER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function feed (tenants, settings, extra = {}) {
  const config = parser.parse({ connectionEnv: 'PG', channel: 'd6_signal', pageSize: 256, degradedPages: 4, intervalMs: 1000, heartbeatTimeoutMs: 5000, ...settings });
  const client = new EventEmitter(), checks = [], hinted = [];
  let at = 1000000;
  client.query = async () => {}; client.end = async () => client.emit('end');
  const instance = consumerFactory.create({ config, tenants, now: () => at, connect: async () => client, schedule: () => null, cancel: () => {}, alert: () => {},
    check: async (batch, { hints }) => { checks.push(batch); hinted.push(new Map(hints)); }, ...extra });
  const heartbeat = () => client.emit('notification', { channel: config.channel, payload: JSON.stringify({ v: 1, k: 'heartbeat', reader: READER }) });
  const hint = (k, t) => client.emit('notification', { channel: config.channel, payload: JSON.stringify({ v: 1, k, t }) });
  // One scheduler interval: the clock moves, the reader's heartbeat arrives, the tick runs.
  const step = async (ms = config.intervalMs, beat = true) => { at += ms; if (beat) heartbeat(); await instance.tick(); };
  // start() reconciles the whole roster (degraded until a heartbeat and a full cover).
  const healthy = async () => { await instance.start(); heartbeat(); await instance.tick(); await step(); assert.equal(instance.health().degraded, false); checks.length = 0; hinted.length = 0; };
  return { instance, client, checks, hinted, heartbeat, hint, step, healthy, config, advance: ms => { at += ms; } };
}
describe('change-feed healthy sweep period', function () {
  it('accepts a bounded sweepMs for consumers only and never one shorter than a tick', function () {
    assert.equal(parser.parse({ connectionEnv: 'PG', channel: 'x', intervalMs: 1000, sweepMs: 30000 }).sweepMs, 30000);
    assert.equal(parser.parse({ connectionEnv: 'PG', channel: 'x' }).sweepMs, undefined);
    for (const sweepMs of [999, 0, 1.5, '30000', 3600001]) assert.throws(() => parser.parse({ connectionEnv: 'PG', channel: 'x', intervalMs: 1000, sweepMs }), /FEED_CONFIG/);
    assert.throws(() => parser.parse({ connectionEnv: 'PG', namespace: 'feed', clockNamespace: 'clock', activityNamespace: 'control', slot: 's', publication: 'p', channel: 'x', owner: 'o', sweepMs: 30000 }, undefined, { reader: true }), /FEED_CONFIG/);
  });
  it('refuses an evaluator sweep longer than half its evaluation-gap alert bound', function () {
    assert.equal(parser.sweepWithin(undefined, 60000), true);
    assert.equal(parser.sweepWithin(parser.parse({ connectionEnv: 'PG', channel: 'x' }), 60000), true);
    assert.equal(parser.sweepWithin({ sweepMs: 30000 }, 60000), true);
    assert.equal(parser.sweepWithin({ sweepMs: 30001 }, 60000), false, 'FEED_SWEEP_EXCEEDS_ALERT_BOUND');
    const source = require('node:fs').readFileSync(require.resolve('../lib/server/serve/evaluator-config'), 'utf8');
    assert.match(source, /sweepWithin\(changeFeed, value\.evaluationAlertMs \?\? 60000\)\) invalid\(\)/, 'the evaluator configuration applies the bound');
  });
  it('without sweepMs a healthy tick still rotates one full page', async function () {
    const f = feed(tenantsOf(120), {});
    try { await f.healthy(); await f.step(); await f.step();
      assert.deepEqual(f.checks.map(batch => batch.length), [120, 120], 'FEED_DEFAULT_ROTATION_UNCHANGED'); }
    finally { await f.instance.close(); }
  });
  it('with sweepMs healthy ticks rotate roster*interval/sweep tenants and cover everyone within the sweep', async function () {
    const tenants = tenantsOf(120), f = feed(tenants, { sweepMs: 30000 });
    try { await f.healthy();
      for (let i = 0; i < 30; i++) await f.step();
      assert.deepEqual([...new Set(f.checks.map(batch => batch.length))], [4], 'FEED_SWEEP_RATE');
      assert.deepEqual([...new Set(f.checks.flat())].sort(), [...tenants].sort(), 'FEED_LOST_HINT_BACKSTOP_WITHIN_SWEEP');
      assert.equal(f.instance.health().rotated >= 120, true); }
    finally { await f.instance.close(); }
  });
  it('keeps the sweep period when ticks are slow, and never exceeds one page', async function () {
    const tenants = tenantsOf(120), f = feed(tenants, { sweepMs: 30000 });
    try { await f.healthy();
      for (let i = 0; i < 7; i++) await f.step(4500, true);
      assert.deepEqual([...new Set(f.checks.flat())].length, 120, 'FEED_SWEEP_TIME_BASED');
      const g = feed(tenantsOf(1000), { sweepMs: 1000 });
      try { await g.healthy(); await g.step(); await g.step(4000); assert.deepEqual(g.checks.map(batch => batch.length), [256, 256], 'FEED_PAGE_BUDGET'); }
      finally { await g.instance.close(); } }
    finally { await f.instance.close(); }
  });
  it('checks a hinted tenant on the next tick, ahead of the rotation', async function () {
    const tenants = tenantsOf(120), f = feed(tenants, { sweepMs: 30000 });
    try { await f.healthy(); await f.step();
      const far = tenants[90]; assert.equal(f.checks[0].includes(far), false);
      f.hint('activity', far); await f.step();
      assert.equal(f.checks[1].includes(far), true, 'FEED_HINT_NEXT_TICK'); assert.equal(f.hinted[1].get(far), 'activity'); }
    finally { await f.instance.close(); }
  });
  it('a degraded feed rotates full pages whatever sweepMs says', async function () {
    const tenants = tenantsOf(120), f = feed(tenants, { sweepMs: 30000 });
    try { await f.healthy(); await f.step(); assert.equal(f.checks[0].length, 4);
      await f.step(5001, false); // no heartbeat within heartbeatTimeoutMs
      assert.equal(f.instance.health().degraded, true); assert.equal(f.checks[1].length, 120, 'FEED_DEGRADED_FULL_PAGES');
      f.client.emit('end'); await f.step(1000, false); assert.equal(f.checks[2].length, 120, 'FEED_RECONNECT_FULL_PAGES'); }
    finally { await f.instance.close(); }
  });
  it('resync hints every tenant so an admission change does not wait for the sweep', async function () {
    const tenants = tenantsOf(120), f = feed(tenants, { sweepMs: 30000 });
    try { await f.healthy(); f.instance.resync(); await f.step();
      assert.equal(f.checks[0].length, 120, 'FEED_RESYNC_NEXT_TICK'); assert.equal(f.hinted[0].size, 120); }
    finally { await f.instance.close(); }
  });
  it('a paused tenant is stopped and a written tenant is evaluated on the next tick; due-time alarm work does not wait for the feed', async function () {
    const tenants = tenantsOf(120), paused = new Set(), stamps = new Map(tenants.map(t => [t, 1])), cycles = [], timeCycles = [], due = [];
    const runtime = await require('../lib/server/serve/evaluator-runtime')({ tenants, externalRecovery: true, recoveryIntervalMs: 1000, timeIntervalMs: 1000,
      schedule: () => { throw new Error('no all-tenant schedule in feed mode'); }, cancel: () => {},
      setTimer: (fn, ms) => { const timer = { fn, ms }; due.push(timer); return timer; }, clearTimer: () => {},
      readCurrent: async tenant => ({ tenant, identity: 'a'.repeat(64) }),
      readStamps: async selected => new Map(selected.map(t => [t, { stamp: stamps.get(t), deleted: 0 }])),
      activity: { check: async (op, tenant) => ({ eligible: !paused.has(tenant), state: paused.has(tenant) ? 'paused' : 'active', code: paused.has(tenant) ? 'TENANT_PAUSED' : null }) },
      create: async current => ({ evaluate: async () => { cycles.push(current.tenant); return { checkpoint: stamps.get(current.tenant), signature: { stamp: stamps.get(current.tenant), deleted: 0 } }; },
        evaluateTime: async () => { timeCycles.push(current.tenant); return { checkpoint: stamps.get(current.tenant) }; }, close: () => {} }) });
    const f = feed(tenants, { sweepMs: 30000 }, { check: async selected => { await runtime.backstop(selected); } });
    try { await f.healthy(); await f.step();
      const quiet = tenants[100], written = tenants[101];
      assert.ok(runtime.last(quiet), 'acquired at boot');
      paused.add(quiet); f.hint('activity', quiet); stamps.set(written, 2); f.hint('data', written); cycles.length = 0;
      await f.step();
      assert.equal(runtime.last(quiet), null, 'FEED_PAUSE_STOPS_NEXT_TICK');
      assert.deepEqual(cycles, [written], 'FEED_WRITE_EVALUATED_NEXT_TICK');
      assert.equal(runtime.last(written).inputCheckpoint, 2);
      // Time-driven work: each tenant owns a due timer armed by its own cycle, not by the feed.
      const other = tenants[102], timer = due.filter(t => t.ms <= 1000).at(-1);
      assert.ok(timer, 'a due-time timer is armed without any feed tick');
      const before = timeCycles.length; timer.fn(); await new Promise(resolve => setImmediate(resolve)); await runtime.health();
      for (let i = 0; i < 5 && timeCycles.length === before; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(timeCycles.length, before + 1, 'EVALUATOR_DUE_TIMER_INDEPENDENT_OF_FEED'); assert.ok(other);
      // A paused tenant gets no time-driven work either.
      assert.equal(timeCycles.includes(quiet) && runtime.last(quiet) !== null, false); }
    finally { await f.instance.close(); await runtime.close(); }
  });
});
