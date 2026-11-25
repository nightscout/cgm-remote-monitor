'use strict';

// Lane INC-C (#8898 round, 2026-11-22): the overload inputs. Every switch is
// off unless set (lib/server/serve/overload-switches.js). The one-select ACK
// race against actual PostgreSQL is in tenant-notifications.integration.test.js.
// covers: lib/server/serve/overload-switches.js
const assert = require('node:assert/strict');
const switches = require('../lib/server/serve/overload-switches');
const startRuntime = require('../lib/server/serve/evaluator-runtime');
const metrics = require('../lib/metrics');

const A = '11111111-1111-4111-8111-111111111111';

describe('INC-C overload switches', function () {
  it('every switch is off unless set, and refuses anything but its values', function () {
    assert.equal(switches.oneSelect({}), false); assert.equal(switches.oneSelect({ NS_CONSUMER_ONE_SELECT: ' TRUE ' }), true);
    assert.throws(() => switches.oneSelect({ NS_CONSUMER_ONE_SELECT: '1' }), /NS_CONSUMER_ONE_SELECT/);
  });
});

describe('INC-C instruments', function () {
  it('notification-delivery and time-driven alarm lag carry no tenant label', async function () {
    const instance = metrics.create({ roles: ['evaluator'] });
    instance.evaluator(() => ({ tenants: 1, pending: 0, queued: 0, oldestAgeMs: 0, residents: 1 }));
    instance.lag('notification', 2500); instance.lag('alarm', 800); instance.lag('alarm', -3);
    const text = await instance.text(); instance.register.clear();
    assert.match(text, /^nightscout_notification_delivery_lag_seconds_bucket\{.*slice=/m);
    assert.match(text, /^nightscout_alarm_time_lag_seconds_count\{.*slice="all"\} 2$/m);
    assert.equal(text.split('\n').some(line => /tenant="/.test(line)), false, 'TENANT_LABEL');
  });
  it('the runtime observes alarm lag once per due instant, not for the slow timer', async function () {
    const observed = [];
    let at = 1000000; const due = { reason: 'timeago', slow: [] };
    const runtime = await startRuntime({ tenants: [A], readCurrent: async () => ({ tenant: A, identity: 'f'.repeat(64) }),
      create: async () => ({ evaluate: async ({ at: now }) => ({ checkpoint: 1, progress: null, now, emitted: [], requested: [], properties: {}, due: { ...due, dueAt: now + 60000 } }),
        evaluateTime: async ({ at: now }) => ({ checkpoint: 1, progress: null, now, emitted: [], requested: [], properties: {}, due: { reason: 'slow', slow: ['x'], dueAt: Infinity } }), close () {} }),
      recoveryIntervalMs: 1000, timeIntervalMs: 120000, schedule: () => ({}), cancel () {}, setTimer: () => ({}), clearTimer () {}, now: () => at });
    const lagged = require('../lib/metrics');
    const saved = Object.getOwnPropertyDescriptor(lagged, 'lag');
    Object.defineProperty(lagged, 'lag', { configurable: true, writable: true, value: (stage, ms) => observed.push([stage, ms]) });
    try {
      at += 61000; await runtime.tick(A); // 1 s after the due instant
      at += 1000; await runtime.tick(A); // armed on the slow timer now: no observation
      assert.deepEqual(observed.filter(([stage]) => stage === 'alarm'), [['alarm', 1000]]);
    } finally { Object.defineProperty(lagged, 'lag', saved); await runtime.close(); }
  });
});
