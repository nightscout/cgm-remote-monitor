'use strict';

// The evaluation-gap alert and serve-then-warm boot of the evaluator runtime
// (perf lane EV; decision readiness-serve-then-warm). Actual runtime, synthetic
// components with a change signature, controlled clock and schedules.
// covers: lib/server/serve/evaluator-runtime.js
const assert = require('node:assert/strict');
const startRuntime = require('../lib/server/serve/evaluator-runtime');

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
const settle = () => new Promise(resolve => setImmediate(resolve));

function lab ({ tenants = [A, B], boot = 'all', bootConcurrency, isWarm, hold } = {}) {
  let at = 1000000; const schedules = [], alerts = [], order = [];
  const stuck = new Set(), gates = new Map();
  const runtime = startRuntime({ tenants, readCurrent: async tenant => ({ tenant, identity: 'c'.repeat(64) }),
    create: async current => ({
      async evaluate () {
        order.push(current.tenant);
        if (hold) { const gate = {}; gate.promise = new Promise(resolve => { gate.resolve = resolve; }); gates.set(current.tenant, gate); await gate.promise; }
        return { checkpoint: 1, signature: { stamp: 1, rows: 1, digest: 'x' }, due: { dueAt: null, reason: null, slow: [] } };
      },
      async evaluateTime () { return { checkpoint: 1, due: { dueAt: null, reason: null, slow: [] } }; },
      // A stuck tenant: its change check never completes (suppressed evaluation).
      signature: () => stuck.has(current.tenant) ? new Promise(() => {}) : Promise.resolve({ stamp: 1, rows: 1, digest: 'x' }),
      close () {} }),
    recoveryIntervalMs: 1000, timeIntervalMs: 60000, evaluationAlertMs: 30000, now: () => at,
    schedule: (fn, ms) => { schedules.push({ fn, ms }); return schedules.length; }, cancel () {},
    setTimer: () => ({}), clearTimer () {}, boot, bootConcurrency, isWarm,
    alert: (code, tenant, ageMs) => alerts.push([code, tenant, ageMs]) });
  return { runtime, alerts, order, stuck, gates, advance: ms => { at += ms; },
    backstop: async () => { const r = await runtime; await r.backstop(); },
    watch: () => schedules.find(s => s.ms === 7500).fn() };
}

describe('evaluator evaluation-gap alert', function () {
  it('a tenant whose evaluation is suppressed alerts once past the bound; the others do not; it clears when evaluated', async function () {
    const l = lab(); const runtime = await l.runtime;
    try {
      l.stuck.add(B);
      for (let i = 0; i < 31; i++) { l.advance(1000); l.backstop(); await settle(); }
      l.watch(); l.watch();
      assert.deepEqual(l.alerts.map(([code, tenant]) => [code, tenant]), [['EVALUATOR_NOT_EVALUATED_WITHIN_BOUND', B]], 'EV_GAP_ALERT only the suppressed tenant, once');
      assert.ok(l.alerts[0][2] > 30000);
      const health = Object.fromEntries(runtime.health().tenants.map(t => [t.tenant, t]));
      assert.equal(health[B].alert, 'EVALUATOR_NOT_EVALUATED_WITHIN_BOUND'); assert.equal(health[A].alert, null);
      assert.ok(health[A].evaluatedAgeMs <= 1000);
      assert.deepEqual(runtime.health().alerts, [{ tenant: B, code: 'EVALUATOR_NOT_EVALUATED_WITHIN_BOUND' }]);
      l.stuck.delete(B); await runtime.acquire(B); l.watch();
      assert.equal(runtime.health().tenants.find(t => t.tenant === B).alert, null, 'EV_GAP_ALERT_CLEARS');
    } finally { await runtime.close(); }
  });
  it('a paused or withdrawn tenant is not expected to be evaluated and does not alert', async function () {
    let paused = false;
    const schedules = [], alerts = []; let at = 0;
    const runtime = await startRuntime({ tenants: [A], readCurrent: async tenant => ({ tenant, identity: 'c'.repeat(64) }),
      create: async () => ({ async evaluate () { return { checkpoint: 1 }; }, async evaluateTime () { return { checkpoint: 1 }; }, close () {} }),
      activity: { check: async (op, tenant) => ({ tenant, eligible: !paused, state: paused ? 'paused' : 'active', code: paused ? 'TENANT_PAUSED' : null }) },
      recoveryIntervalMs: 1000, timeIntervalMs: 60000, evaluationAlertMs: 30000, now: () => at,
      schedule: (fn, ms) => { schedules.push({ fn, ms }); return schedules.length; }, cancel () {}, setTimer: () => ({}), clearTimer () {},
      alert: (...args) => alerts.push(args) });
    try {
      paused = true; await runtime.tick(A); at += 60000; schedules.find(s => s.ms === 7500).fn();
      assert.deepEqual(alerts, []);
    } finally { await runtime.close(); }
  });
});

describe('evaluator serve-then-warm boot', function () {
  it('returns before acquiring, acquires warm tenants first, at most bootConcurrency at once, and the backstop leaves queued tenants alone', async function () {
    const warm = new Set([C, D]);
    const l = lab({ tenants: [A, B, C, D], boot: 'serve', bootConcurrency: 1, isWarm: tenant => warm.has(tenant), hold: true });
    const runtime = await l.runtime;
    try {
      assert.equal(runtime.last(A), null, 'EV_SERVE_BOOT returns before any acquisition completes');
      await settle();
      assert.deepEqual(l.order, [C], 'EV_SERVE_BOOT_WARM_FIRST and one at a time');
      await runtime.backstop(); await settle();
      assert.deepEqual(l.order, [C], 'the backstop does not start queued tenants');
      for (const expected of [[C, D], [C, D, A], [C, D, A, B]]) {
        l.gates.get(l.order.at(-1)).resolve(); await settle(); await settle();
        assert.deepEqual(l.order, expected);
      }
      l.gates.get(B).resolve(); await settle(); await settle();
      assert.ok([A, B, C, D].every(tenant => runtime.last(tenant)), 'every tenant acquired');
      assert.ok(runtime.health().tenants.every(t => !t.booting));
    } finally { for (const gate of l.gates.values()) gate.resolve(); await runtime.close(); }
  });
});
