'use strict';

// The evaluator output revision changes only with content: checkpoint,
// progress, emitted, requested and properties. Actual runtime, actual views and
// plugins over synthetic data; only the clock is controlled.
// covers: lib/server/serve/evaluator-runtime.js
const assert = require('node:assert/strict');
const startRuntime = require('../lib/server/serve/evaluator-runtime');
const levels = require('../lib/levels');

const A = '11111111-1111-4111-8111-111111111111';
const identity = 'a'.repeat(64);

describe('evaluator output revision follows content, not cycles', function () {
  // The single-site stale-data alarm (timeago with enableAlerts). The tenant
  // environment cannot carry extendedSettings.timeago today, so the env is
  // built in the single-site shape here.
  const env = require('../lib/server/tenant-app/environment')({ settings: { enable: ['bgnow', 'delta', 'direction', 'timeago'],
    alarmTimeagoWarn: true, alarmTimeagoWarnMins: 15, alarmTimeagoUrgent: true, alarmTimeagoUrgentMins: 30 } });
  env.extendedSettings = { timeago: { enableAlerts: true } };
  const view = require('../lib/data/views')(env, { language: require('../lib/language')(), levels, moment: require('moment-timezone') });
  const t0 = Date.UTC(2026, 10, 10, 12);
  function cycle (at) {
    const ddata = require('../lib/data/ddata')(); ddata.lastUpdated = at;
    ddata.sgvs = [{ _id: 'synthetic', mgdl: 120, mills: t0 - 60000, type: 'sgv', direction: 'Flat' }];
    return { checkpoint: 7, progress: null, ...view.evaluateCycle({ now: at, ddata }) };
  }

  it('keeps the revision and frozen output for an identical time-only cycle and bumps it when only time passes into a stale-data alarm', async function () {
    let at = t0; const woken = [];
    const runtime = await startRuntime({ tenants: [A], readCurrent: async () => ({ tenant: A, identity }),
      create: async () => ({ evaluate: async ({ at }) => cycle(at), evaluateTime: async ({ at }) => cycle(at), close () {} }),
      recoveryIntervalMs: 1000, timeIntervalMs: 1000, schedule: () => ({}), cancel () {}, now: () => at, onRevision: tenant => woken.push(tenant) });
    try {
      const first = runtime.last(A);
      assert.equal(first.outputRevision, 1); assert.deepEqual(woken, [A]);
      at = t0 + 60000; await runtime.tick(A); at = t0 + 61000; await runtime.acquire(A);
      const held = runtime.last(A);
      assert.equal(held.outputRevision, 1, 'EVALUATOR_IDENTICAL_CONTENT_KEEPS_REVISION');
      assert.equal(held.result, first.result, 'the same frozen output object');
      assert.deepEqual(woken, [A], 'no wake for identical content');
      assert.equal(runtime.health().tenants[0].cycles, 3, 'every cycle still ran');
      at = t0 + 20 * 60000; await runtime.tick(A);
      const stale = runtime.last(A);
      assert.ok(stale.result.requested.some(row => row.kind === 'notify' && row.plugin?.name === 'timeago'), 'only time passed and the stale-data alarm appeared');
      assert.equal(stale.outputRevision, 2, 'EVALUATOR_TIME_DRIVEN_CONTENT_BUMPS');
      assert.deepEqual(woken, [A, A]);
    } finally { await runtime.close(); }
  });

  it('defines content as exactly the fields consumers and the producer read', function () {
    assert.deepEqual(startRuntime.CONTENT, ['checkpoint', 'progress', 'emitted', 'requested', 'properties']);
    const base = cycle(t0);
    assert.equal(startRuntime.contentDigest({ ...base, now: t0 + 1, evaluationRevision: 9, trigger: 'time-only' }), startRuntime.contentDigest(base),
      'per-cycle metadata is not content');
    assert.equal(startRuntime.contentDigest({ ...base, properties: JSON.parse(JSON.stringify(base.properties)) }), startRuntime.contentDigest(base),
      'canonical: a JSON round trip of the same values has the same digest');
    for (const key of startRuntime.CONTENT) {
      assert.notEqual(startRuntime.contentDigest({ ...base, [key]: { changed: key } }), startRuntime.contentDigest(base), key + ' is content');
    }
  });
});
