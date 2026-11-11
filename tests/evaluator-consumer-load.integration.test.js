'use strict';

// Alarm repeat clock and consumer load at the deployed intervals: actual
// selected evaluator role (child), actual realtime consumer, restricted
// PostgreSQL, controlled UDS sink. Two synthetic tenants, each with an active
// low. The evaluator is driven only by its own timers, as in deployment.
// covers: lib/server/serve/evaluator-runtime.js, lib/server/serve/evaluator-consumers.js, lib/tenant-notifications/producer-state.js, lib/tenant-notifications/producer.js
const assert = require('node:assert/strict');
const {optInSuite} = require('./support/opt-in');
const createLab = require('./fixtures/evaluator-consumers-native');

// Deployed timers (deploy/multitenant/config.js:96-103) by default. The
// tenant heartbeat (seconds, the single-site setting) and window are short so
// the case runs in CI; NS_CONSUMER_LOAD_HEARTBEAT_S=60 NS_CONSUMER_LOAD_WINDOW_MS=60000
// measures the deployed default. NS_CONSUMER_LOAD_ASSERT=0 records without verdicts.
const number = (name, fallback) => process.env[name] ? Number(process.env[name]) : fallback;
const EVALUATOR_MS = number('NS_CONSUMER_LOAD_EVALUATOR_MS', 1000);
const POLL_MS = number('NS_CONSUMER_LOAD_POLL_MS', 1000);
const HEARTBEAT_S = number('NS_CONSUMER_LOAD_HEARTBEAT_S', 5);
const WINDOW_MS = number('NS_CONSUMER_LOAD_WINDOW_MS', 21000);
const ASSERT = process.env.NS_CONSUMER_LOAD_ASSERT !== '0';

optInSuite(process.env.NS_EVALUATOR_CONSUMERS_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_EVALUATOR_CONSUMERS_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'evaluator alarm repeat clock and consumer load at deployed intervals', function () {
    this.timeout(WINDOW_MS + 90000);
    const lab = createLab();
    before(() => lab.open()); beforeEach(() => lab.reset()); after(() => lab.close());
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function reading (value, tenant, id) {
      const at = await lab.epoch();
      await lab.persistDomains({entries:[{_id:id,type:'sgv',sgv:value,date:at-1000,
        dateString:new Date(at-1000).toISOString(),direction:'Flat'}]}, tenant);
    }
    const alarms = tenant => lab.sinkEffects.filter(row => row.tenant === tenant && !row.notification?.clear);
    async function boot () {
      await reading(50, lab.A, 'synthetic-a'); await reading(50, lab.B, 'synthetic-b');
      await lab.provisionPreview(); await lab.openSink();
      const worker = await lab.workerConsumers(lab.configureConsumers(document => {
        document.recoveryIntervalMs = EVALUATOR_MS; document.timeIntervalMs = EVALUATOR_MS;
        document.tenants.forEach(tenant => { tenant.settings.heartbeat = HEARTBEAT_S; });
        Object.assign(document.consumers.realtime, { pollIntervalMs: POLL_MS, retryIntervalMs: POLL_MS,
          retryDelayMs: Math.min(POLL_MS, 1000), attemptTimeoutMs: 10000 });
      }));
      assert.equal(worker.startup.ready, true, JSON.stringify(worker.startup));
      await lab.wait(async () => alarms(lab.A).length >= 1 && alarms(lab.B).length >= 1);
      await sleep(Math.floor(Math.random() * EVALUATOR_MS)); // random phase against the evaluator timers
      return worker;
    }
    async function sample (worker) {
      const health = await worker.call('health');
      return Object.fromEntries([lab.A, lab.B].map(tenant => {
        const evaluator = health.tenants.find(row => row.tenant === tenant);
        const consumer = health.consumers.tenants.find(row => row.tenant === tenant);
        return [tenant, { cycles: evaluator.cycles, revision: evaluator.outputRevision, passes: consumer.passes,
          selections: consumer.selections, code: consumer.code, alarms: alarms(tenant).length }];
      }));
    }
    async function stuck () {
      const at = await lab.epoch(); let count = 0;
      for (const tenant of [lab.A, lab.B]) count += (await lab.requests(tenant)).filter(row => row.state === 'attempting' && Number(row.attempt_until) < at).length;
      return count;
    }

    it('repeats each active alarm on the tenant heartbeat, not on every evaluator cycle, and delivers a changed reading promptly', async function () {
      const worker = await boot();
      const start = await sample(worker), t0 = Date.now();
      await sleep(WINDOW_MS);
      const end = await sample(worker), minutes = (Date.now() - t0) / 60000;
      const rate = key => Object.fromEntries([lab.A, lab.B].map(tenant => [tenant.slice(0, 1), +((end[tenant][key] - start[tenant][key]) / minutes).toFixed(1)]));
      await reading(40, lab.A, 'synthetic-a-changed'); const changedAt = Date.now(); // no explicit acquire or wake
      const latencyMs = await lab.wait(async () => lab.sinkEffects.some(row => row.tenant === lab.A && row.notification?.debug?.lastSGV === 40))
        .then(() => Date.now() - changedAt, () => null);
      const after = await sample(worker);
      const trace = lab.traceConsumer('load-before-verdict', { evaluatorMs: EVALUATOR_MS, pollMs: POLL_MS, heartbeatS: HEARTBEAT_S, windowMs: WINDOW_MS,
        perMinute: { cycles: rate('cycles'), revisions: rate('revision'), passes: rate('passes'), selections: rate('selections'), alarmDeliveries: rate('alarms') },
        latencyMs, refused: Object.values(after).filter(row => row.code === 'EVALUATOR_CONSUMER_REFUSED').length, stuckAttempting: await stuck() });
      if (ASSERT) {
        const expected = WINDOW_MS / (HEARTBEAT_S * 1000);
        for (const tenant of [lab.A, lab.B]) {
          const delivered = end[tenant].alarms - start[tenant].alarms;
          assert.ok(delivered >= Math.floor(expected) - 1 && delivered <= Math.ceil(expected) + 1,
            'ALARM_REPEAT_ON_HEARTBEAT ' + tenant.slice(0, 1) + ' delivered ' + delivered + ', expected about ' + expected.toFixed(1) + ' ' + JSON.stringify(trace));
        }
        assert.ok(latencyMs !== null && latencyMs <= EVALUATOR_MS + 2000, 'CHANGED_READING_LATENCY ' + JSON.stringify(trace));
        assert.equal(trace.refused, 0, 'NO_CONSUMER_REFUSAL'); assert.equal(trace.stuckAttempting, 0, 'NO_STUCK_ATTEMPTING');
      }
      await lab.stopConsumer(worker);
    });

    it('does not repeat an acknowledged alarm during its silence', async function () {
      const worker = await boot();
      await lab.ack(lab.A, 2, 60 * 60000);
      await lab.wait(async () => lab.sinkEffects.some(row => row.tenant === lab.A && row.notification?.clear));
      const startA = alarms(lab.A).length, startB = alarms(lab.B).length;
      await sleep(Math.max(3 * HEARTBEAT_S * 1000, 3000));
      const trace = lab.traceConsumer('ack-silence-before-verdict', { heartbeatS: HEARTBEAT_S,
        acknowledgedRepeats: alarms(lab.A).length - startA, otherTenantRepeats: alarms(lab.B).length - startB });
      if (ASSERT) {
        assert.equal(trace.acknowledgedRepeats, 0, 'ALARM_ACK_SILENCE_HOLDS ' + JSON.stringify(trace));
        assert.ok(trace.otherTenantRepeats >= 1, 'ALARM_REPEAT_OTHER_TENANT ' + JSON.stringify(trace));
      }
      await lab.stopConsumer(worker);
    });
  });
