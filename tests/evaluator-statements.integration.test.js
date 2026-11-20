'use strict';
// Statement cost per accepted write on the actual evaluator role (lane A1 of
// the evaluator-less-work brief, 2026-11-20). The fixture worker counts every
// statement by pool application_name; this suite writes one reading at a time,
// waits until the durable completed output covers it, lets the role settle and
// reports the statements issued. It also reports one time-only (due) cycle.
// Synthetic tenants and readings only.
const assert = require('node:assert/strict');
const { optInSuite } = require('./support/opt-in');
const { summarize } = require('./lib/statement-summary');
const enabled = process.env.NS_PGSTREAM_RECOVERY_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI;
const WRITES = Number(process.env.NS_EVALUATOR_STATEMENTS_WRITES || 5);
const BOUND = process.env.NS_EVALUATOR_STATEMENTS_BOUND === undefined ? null : Number(process.env.NS_EVALUATOR_STATEMENTS_BOUND);

optInSuite(enabled, 'NS_PGSTREAM_RECOVERY_TEST=1 and owned disposable PostgreSQL plus canonical pgstream fixture inputs')(
  'evaluator statements per accepted write', function () {
    this.timeout(120000);
    const lab = require('./fixtures/evaluator-preview-registry-lab')();
    before(() => lab.open());
    beforeEach(() => lab.reset());
    after(() => lab.close());
    const floor = value => BigInt(value || '0');
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function wait (check, ms, symptom) {
      const end = Date.now() + ms;
      while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(20); }
      throw new Error(symptom);
    }
    const work = require('../lib/pgstream/work-state');
    async function completedFloor (tenant = lab.A) {
      const row = await lab.previewCompleted(tenant);
      return floor(work.map(row.work_completed).bootstrap);
    }
    async function accepted (value, id, tenant = lab.A) {
      return wait(async () => {
        const saved = await lab.checkpoint(lab.consumerName, tenant), input = saved.projection?.[0];
        const event = saved.projection?.[1]?.events.find(row => row.domain === 'entries' && row.value.doc?.identifier === id && row.value.doc.sgv === value);
        return input?.stream?.accepted_position && event ? floor(input.floor) : null;
      }, 10000, 'INPUT_NOT_ACCEPTED');
    }
    async function settle (worker) {
      // Quiescent when two consecutive 300 ms windows add no evaluator or receiver statement.
      let last = -1;
      for (let i = 0; i < 50; i++) {
        await sleep(300);
        const now = Object.entries(await worker.call('statements')).filter(([shape]) => !shape.startsWith('nightscout-evaluator-registry')).reduce((sum, [, n]) => sum + n, 0);
        if (now === last) return;
        last = now;
      }
    }

    // The fixture's four plugins, then the shipping default feature list (which enables the dbsize pill).
    it('reports statements per accepted write and per time-only cycle', () => measure('fixture-plugins'));
    it('reports the same with the shipping default plugins', async () => {
      await lab.setSettings({ enable: require('../lib/settings')().DEFAULT_FEATURES });
      await measure('default-plugins');
    });
    async function measure (label) {
      const at = Date.now();
      await lab.persistDomains({ entries: [{ _id: 'statement-seed', type: 'sgv', sgv: 100, date: at - 1000, dateString: new Date(at - 1000).toISOString(), direction: 'Flat' }] });
      await lab.provisionPreview();
      const worker = await lab.worker(lab.configure());
      try {
        assert.equal(worker.startup.ready, true, JSON.stringify(worker.startup));
        await worker.call('acquire', lab.A);
        await lab.wait(async () => !!(await worker.call('last', lab.A)));
        // Warm-up write: the first stream input may take a cold path.
        for (let i = 0; i < 2; i++) {
          const now = Date.now();
          await lab.persistDomains({ entries: [{ _id: 'warm-' + i, type: 'sgv', sgv: 90 + i, date: now, dateString: new Date(now).toISOString(), direction: 'Flat' }] });
          const stamp = await accepted(90 + i, 'warm-' + i);
          await wait(async () => await completedFloor() >= stamp, 10000, 'WARM_COMPLETION');
        }
        await settle(worker);
        await worker.call('statements', lab.A, { reset: true });
        for (let i = 0; i < WRITES; i++) {
          const now = Date.now(), value = 120 + i, id = 'statement-' + i;
          await lab.persistDomains({ entries: [{ _id: id, type: 'sgv', sgv: value, date: now, dateString: new Date(now).toISOString(), direction: 'Flat' }] });
          const stamp = await accepted(value, id);
          await wait(async () => await completedFloor() >= stamp, 10000, 'COMPLETION');
          await settle(worker);
        }
        const writes = summarize(await worker.call('statements', lab.A, { reset: true }), WRITES);
        const output = await lab.previewCompleted();
        assert.equal(output.projection[0].output.frame.sgvs.find(row => row._id === 'statement-' + (WRITES - 1)).mgdl, 120 + WRITES - 1, 'LAST_WRITE_IN_DURABLE_FRAME');
        // One time-only cycle: no new input.
        const before = await lab.previewCompleted();
        await worker.call('tick', lab.A);
        await settle(worker);
        const tick = summarize(await worker.call('statements', lab.A, { reset: true }), 1);
        const after = await lab.previewCompleted();
        // Idle background over the same settle cadence.
        await sleep(3000);
        const idle = summarize(await worker.call('statements', lab.A, { reset: true }), 1);
        const record = { label, writes, tick, tickRevision: [before.output_revision, after.output_revision], idle3s: idle };
        console.log('EVALUATOR_STATEMENTS ' + JSON.stringify(record));
        if (BOUND !== null) {
          const evaluatorPool = writes.perWriteByPool['nightscout-evaluator-preview'] || 0;
          assert(evaluatorPool <= BOUND, 'EVALUATOR_POOL_STATEMENTS_PER_WRITE ' + evaluatorPool + ' > ' + BOUND);
        }
      } finally { await lab.stopWorker(worker); }
    }
  });
