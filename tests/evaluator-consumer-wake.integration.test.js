'use strict';

// Consumers on change (decision cost-proportional-to-activity): the actual
// evaluator role (child), actual realtime consumer, restricted PostgreSQL and a
// controlled UDS sink. A tenant with no alarm is not polled; a new alarm is
// delivered by the evaluator's revision wake, long before the slow backstop.
// covers: lib/server/serve/evaluator-consumers.js
const assert = require('node:assert/strict');
const {optInSuite} = require('./support/opt-in');
const createLab = require('./fixtures/evaluator-consumers-native');

optInSuite(process.env.NS_EVALUATOR_CONSUMERS_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_EVALUATOR_CONSUMERS_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'evaluator consumers wake on revision, not on a per-tenant poll', function () {
    this.timeout(90000);
    const lab = createLab();
    before(() => lab.open()); beforeEach(() => lab.reset()); after(() => lab.close());
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function reading (value, tenant, id) {
      const at = await lab.epoch();
      await lab.persistDomains({entries:[{_id:id,type:'sgv',sgv:value,date:at-1000,
        dateString:new Date(at-1000).toISOString(),direction:'Flat'}]}, tenant);
    }
    const alarms = tenant => lab.sinkEffects.filter(row => row.tenant === tenant && !row.notification?.clear);
    it('an idle tenant gets no polling pass; a new low is delivered by the revision wake well before the backstop', async function () {
      await reading(120, lab.A, 'normal-a'); await reading(120, lab.B, 'normal-b');
      await lab.provisionPreview(); await lab.openSink();
      const worker = await lab.workerConsumers(lab.configureConsumers(document => {
        document.recoveryIntervalMs = 500; document.timeIntervalMs = 60000;
        Object.assign(document.consumers.realtime, { pollIntervalMs: 200, retryIntervalMs: 200, backstopIntervalMs: 600000 });
      }));
      assert.equal(worker.startup.ready, true, JSON.stringify(worker.startup));
      const passes = async () => Object.fromEntries((await worker.call('health')).consumers.tenants.map(row => [row.tenant, row.passes]));
      await sleep(1500); const before = await passes(); await sleep(3000); const after = await passes();
      assert.equal(after[lab.B] - before[lab.B], 0, 'EV_CONSUMER_IDLE_NOT_POLLED no pass for a tenant with nothing to deliver ' + JSON.stringify({ before, after }));
      await reading(45, lab.A, 'urgent-low-a'); const changedAt = Date.now();
      const latencyMs = await lab.wait(async () => alarms(lab.A).length >= 1).then(() => Date.now() - changedAt, () => null);
      lab.traceConsumer('wake-on-revision', { latencyMs, before, after, consumers: (await worker.call('health')).consumers.revisedWakes });
      assert.ok(latencyMs !== null && latencyMs < 10000, 'EV_CONSUMER_REVISION_WAKE delivered in ' + latencyMs + ' ms with a 600 s backstop');
      assert.equal(alarms(lab.B).length, 0);
      await lab.stopConsumer(worker);
    });
    it('a failed delivery is retried with the same request on the fast retry loop, not the backstop', async function () {
      await reading(45, lab.A, 'urgent-low-a');
      await lab.provisionPreview(); await lab.openSink(); lab.sinkMode = 'lost-response';
      const worker = await lab.workerConsumers(lab.configureConsumers(document => {
        document.recoveryIntervalMs = 500; document.timeIntervalMs = 60000;
        Object.assign(document.consumers.realtime, { pollIntervalMs: 200, retryIntervalMs: 200, retryDelayMs: 200, backstopIntervalMs: 600000 });
      }));
      assert.equal(worker.startup.ready, true, JSON.stringify(worker.startup));
      await lab.wait(async () => lab.sinkEffects.some(row => row.tenant === lab.A));
      const first = lab.sinkEffects.find(row => row.tenant === lab.A);
      lab.sinkMode = 'accept'; const switchedAt = Date.now();
      const retriedMs = await lab.wait(async () => (await lab.requests(lab.A)).some(row => row.request_id === first.id && row.state === 'accepted'))
        .then(() => Date.now() - switchedAt, () => null);
      lab.traceConsumer('retry-after-failure', { retriedMs, attempts: lab.sinkEffects.filter(row => row.id === first.id).length });
      assert.ok(retriedMs !== null && retriedMs < 10000, 'EV_CONSUMER_RETRY_PROMPT same request accepted ' + retriedMs + ' ms after the sink recovered');
      assert.ok(lab.sinkEffects.filter(row => row.id === first.id).length >= 2, 'the same request id was attempted again');
      await lab.stopConsumer(worker);
    });
  });
