'use strict';

// The realtime consumer must not refuse because the evaluator's own recovery/
// time timers published a newer output while it was selecting or attempting.
// Actual selected evaluator role (child), actual realtime consumer, restricted
// PostgreSQL, controlled UDS sink. Synthetic tenants A/B only.
// covers: lib/tenant-notifications/producer.js, lib/server/serve/evaluator-consumers.js, lib/tenant-notifications/component.js
const assert = require('node:assert/strict');
const {optInSuite} = require('./support/opt-in');
const createLab = require('./fixtures/evaluator-consumers-native');

// Defaults reproduce the reported condition (timers at 150 ms, phase 0, the
// fixture's manual consumer timers). The NS_CONSUMER_* knobs are for measurement
// sweeps only: timer interval, phase relative to the timers, consumer timers as
// deployed, and NS_CONSUMER_REQUIRE_DELIVERY=1 to also require the changed
// reading to be delivered (not guaranteed under churn with manual consumer
// timers: see the freshness gate in component.js eligible()).
const CHURN_MS = Number(process.env.NS_CONSUMER_CHURN_MS || 150);
const POLL_MS = process.env.NS_CONSUMER_POLL_MS ? Number(process.env.NS_CONSUMER_POLL_MS) : null;
const ATTEMPT_MS = process.env.NS_CONSUMER_ATTEMPT_MS ? Number(process.env.NS_CONSUMER_ATTEMPT_MS) : null;
const PHASE = process.env.NS_CONSUMER_PHASE || '0';
const DEADLINE_MS = Number(process.env.NS_CONSUMER_DEADLINE_MS || 10000);
const REQUIRE_DELIVERY = process.env.NS_CONSUMER_REQUIRE_DELIVERY === '1';

optInSuite(process.env.NS_EVALUATOR_CONSUMERS_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_EVALUATOR_CONSUMERS_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'evaluator realtime consumer under evaluator timer churn', function () {
    this.timeout(60000);
    const lab = createLab();
    before(() => lab.open()); beforeEach(() => lab.reset()); after(() => lab.close());
    async function reading (value, tenant = lab.A, id = 'synthetic-' + value) {
      const at = await lab.epoch();
      await lab.persistDomains({entries:[{_id:id,type:'sgv',sgv:value,date:at-1000,
        dateString:new Date(at-1000).toISOString(),direction:'Flat'}]}, tenant);
    }
    const effects = tenant => lab.sinkEffects.filter(row => row.tenant === tenant);
    const lastSgv = row => row.notification?.debug?.lastSGV;

    it('does not refuse a changed reading while evaluator timers publish every ' + CHURN_MS + ' ms', async function () {
      await reading(50); await reading(111, lab.B);
      await lab.provisionPreview(); await lab.openSink();
      const worker = await lab.workerConsumers(lab.configureConsumers(document => {
        document.recoveryIntervalMs = CHURN_MS; document.timeIntervalMs = CHURN_MS;
        const realtime = document.consumers.realtime;
        if (POLL_MS) { realtime.pollIntervalMs = POLL_MS; realtime.retryIntervalMs = POLL_MS; realtime.retryDelayMs = Math.min(POLL_MS, 1000); }
        if (ATTEMPT_MS) realtime.attemptTimeoutMs = ATTEMPT_MS;
      }));
      assert.equal(worker.startup.ready, true, JSON.stringify(worker.startup));
      await worker.call('flush', lab.A); await worker.call('flush', lab.B);
      const phase = PHASE === 'random' ? Math.floor(Math.random() * CHURN_MS) : Number(PHASE);
      if (phase) await new Promise(resolve => setTimeout(resolve, phase));
      await reading(40, lab.A, 'synthetic-changed');
      const started = Date.now();
      // acquire also wakes the consumer; the explicit wake is a second drain.
      await worker.call('acquire', lab.A); await worker.call('wake', lab.A);
      const consumer = (await worker.call('flush', lab.A)).consumers.tenants.find(row => row.tenant === lab.A);
      let delivered;
      const deadline = Date.now() + DEADLINE_MS;
      while (REQUIRE_DELIVERY && !(delivered = effects(lab.A).find(row => lastSgv(row) === 40)) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const trace = lab.traceConsumer('churn-before-verdict', { churnMs: CHURN_MS, pollMs: POLL_MS, phaseMs: phase, consumer,
        latencyMs: delivered ? Date.now() - started : null,
        requests: (await lab.requests(lab.A)).map(row => ({ state: row.state, attempt: row.attempt, lastSGV: row.payload?.debug?.lastSGV })),
        effects: effects(lab.A).map(lastSgv) });
      assert.notEqual(consumer.code, 'EVALUATOR_CONSUMER_REFUSED', 'CONSUMER_CHURN_NOT_REFUSED ' + JSON.stringify(trace));
      if (REQUIRE_DELIVERY) assert.ok(delivered, 'CONSUMER_CHURN_CHANGED_READING_DELIVERED');
      await lab.stopConsumer(worker);
    });
  });
