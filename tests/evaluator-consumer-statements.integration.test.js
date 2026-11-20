'use strict';
// Statement cost per accepted write on the actual evaluator role with its
// notification consumer (outbox and suppression pools), lane A1 of the
// evaluator-less-work brief (2026-11-20). Quiet readings first, then one
// reading that raises an urgent alarm, which must still reach the sink.
// Synthetic tenants and readings only.
const assert = require('node:assert/strict');
const { optInSuite } = require('./support/opt-in');
const { summarize } = require('./lib/statement-summary');
const createLab = require('./fixtures/evaluator-consumers-native');
const WRITES = Number(process.env.NS_EVALUATOR_STATEMENTS_WRITES || 5);

optInSuite(process.env.NS_EVALUATOR_CONSUMERS_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_EVALUATOR_CONSUMERS_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'evaluator with notification consumer: statements per accepted write', function () {
    this.timeout(120000);
    const lab = createLab();
    before(() => lab.open()); beforeEach(() => lab.reset()); after(() => lab.close());
    const floor = value => BigInt(value || '0');
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const work = require('../lib/pgstream/work-state');
    async function wait (check, ms, symptom) {
      const end = Date.now() + ms;
      while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(20); }
      throw new Error(symptom);
    }
    async function completedFloor (tenant = lab.A) { return floor(work.map((await lab.previewCompleted(tenant)).work_completed).bootstrap); }
    async function accepted (value, id, tenant = lab.A) {
      return wait(async () => {
        const saved = await lab.checkpoint(lab.consumerName, tenant), input = saved.projection?.[0];
        const event = saved.projection?.[1]?.events.find(row => row.domain === 'entries' && row.value.doc?.identifier === id && row.value.doc.sgv === value);
        return input?.stream?.accepted_position && event ? floor(input.floor) : null;
      }, 10000, 'INPUT_NOT_ACCEPTED');
    }
    async function settle (worker) {
      let last = -1;
      for (let i = 0; i < 50; i++) {
        await sleep(300);
        const now = Object.entries(await worker.call('statements')).filter(([shape]) => !shape.startsWith('nightscout-evaluator-registry')).reduce((sum, [, n]) => sum + n, 0);
        if (now === last) return;
        last = now;
      }
    }
    async function write (worker, value, id) {
      const now = await lab.epoch();
      await lab.persistDomains({ entries: [{ _id: id, type: 'sgv', sgv: value, date: now - 1000, dateString: new Date(now - 1000).toISOString(), direction: 'Flat' }] });
      const stamp = await accepted(value, id);
      await wait(async () => await completedFloor() >= stamp, 10000, 'COMPLETION');
      await worker.call('flush', lab.A);
      await settle(worker);
    }
    it('reports statements per quiet write and per alarming write; the alarm still reaches the sink', async function () {
      const seed = await lab.epoch();
      await lab.persistDomains({ entries: [{ _id: 'consumer-seed', type: 'sgv', sgv: 100, date: seed - 1000, dateString: new Date(seed - 1000).toISOString(), direction: 'Flat' }] });
      await lab.provisionPreview(); await lab.openSink();
      const worker = await lab.workerConsumers(lab.configureConsumers());
      try {
        assert.equal(worker.startup.ready, true, JSON.stringify(worker.startup));
        await worker.call('acquire', lab.A); await worker.call('flush', lab.A);
        for (let i = 0; i < 2; i++) await write(worker, 90 + i, 'consumer-warm-' + i);
        await worker.call('statementsReset');
        for (let i = 0; i < WRITES; i++) await write(worker, 120 + i, 'consumer-quiet-' + i);
        const quiet = summarize(await worker.call('statementsReset'), WRITES);
        const durable = await lab.previewCompleted();
        const marker = (await lab.admin.query('SELECT notification_work_pending FROM "' + lab.replayNamespace + '".tenant_consumer_checkpoint WHERE tenant_id=$1 AND consumer=$2', [lab.A, lab.consumerName + '-completed'])).rows[0];
        console.log('EVALUATOR_QUIET_OUTPUT ' + JSON.stringify({ requested: durable.projection[0].output.result.requested, emitted: durable.projection[0].output.result.emitted?.length, marker }));
        const before = lab.sinkEffects.length;
        await write(worker, 400, 'consumer-urgent');
        await wait(async () => lab.sinkEffects.length > before, 10000, 'URGENT_ALARM_MUST_REACH_SINK');
        await settle(worker);
        const alarm = summarize(await worker.call('statementsReset'), 1);
        console.log('EVALUATOR_STATEMENTS ' + JSON.stringify({ label: 'consumer-quiet', writes: quiet, tick: alarm, tickRevision: ['alarm', 'write'] }));
        assert(lab.sinkEffects.slice(before).length > 0, 'ALARM_DELIVERED');
      } finally { await lab.stopConsumer(worker); }
    });
  });
