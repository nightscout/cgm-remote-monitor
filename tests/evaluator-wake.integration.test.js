'use strict';

// Work on change (decision cost-proportional-to-activity, D6): the actual
// runtime and evaluator component over actual PostgreSQL, with the backstop
// pass and the due timers driven by the test instead of wall-clock timers.
// The durable-event contract's controls: lost wake, duplicate delivery,
// restart replay; and the change signature's coverage of hard deletes and
// writes to unstamped domains. Decision write-clock-complete: both advance the
// tenant write clock through the supported write path, and the signature is the
// clock pair (last_stamp, last_delete_stamp), read per component or once per
// pass for every tenant (readStamps, the change-stamp function's shape).
// covers: lib/server/serve/evaluator-runtime.js, lib/storage/postgres-durable-replay.js, lib/data/tenant-projection-evaluator.js
const assert = require('node:assert/strict');
const startRuntime = require('../lib/server/serve/evaluator-runtime');
const createLab = require('./fixtures/tenant-projection-evaluator');
const { optInSuite } = require('./support/opt-in');

optInSuite(process.env.NS_TENANT_PROJECTION_EVALUATOR_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_TENANT_PROJECTION_EVALUATOR_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'evaluator work on change: backstop, wake seam and change signature on actual PostgreSQL', function () {
    this.timeout(45000);
    const lab = createLab();
    const at = Date.UTC(2026, 10, 10, 12);
    before(() => lab.open());
    beforeEach(() => lab.reset());
    after(() => lab.close());
    const reading = (id, value, offset = 0) => ({ _id: id, type: 'sgv', sgv: value, date: at - 2 * 60000 + offset,
      dateString: new Date(at - 2 * 60000 + offset).toISOString(), direction: 'Flat' });
    // batch: the backstop reads every tenant's clock pair once per pass, in the
    // change-stamp function's shape (tests/change-stamps.integration.test.js
    // proves the function returns this pair under its own grants).
    async function runtime ({ batch = false } = {}) {
      const passes = [], timers = new Map(), reads = []; let id = 0;
      const readStamps = async tenants => {
        reads.push(tenants);
        const rows = (await lab.admin.query('SELECT tenant_id::text AS tenant, last_stamp::text AS stamp, last_delete_stamp::text AS deleted FROM "' +
          lab.namespaces.clock + '".tenant_write_clock WHERE tenant_id = ANY($1::uuid[])', [tenants])).rows;
        return new Map(rows.map(row => [row.tenant, { stamp: row.stamp, deleted: row.deleted }]));
      };
      const value = await startRuntime({ tenants: [lab.A], readCurrent: async tenant => ({ tenant, identity: 'e'.repeat(64) }),
        ...(batch ? { readStamps } : {}),
        create: async () => lab.evaluator(lab.A), recoveryIntervalMs: 1000, timeIntervalMs: 60000, now: () => at,
        schedule: fn => { passes.push(fn); return passes.length; }, cancel () {},
        setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimer: key => timers.delete(key) });
      return { value, timers, reads, cycles: () => value.health().tenants[0].cycles, mean: () => value.last(lab.A)?.result.properties.bgnow?.mean ?? null,
        counters: () => value.health().wake };
    }

    for (const batch of [false, true]) {
      const suffix = batch ? ' (one stamp read per pass)' : '';
      it('an unchanged tenant costs one signature read per pass and no cycle' + suffix, async function () {
        await lab.persistDomains({ entries: [reading('one', 111, -10 * 60000)] }); await lab.provisionView();
        await lab.at(at, async () => {
          const r = await runtime({ batch });
          try {
            assert.equal(r.mean(), 111); const cycles = r.cycles();
            for (let i = 0; i < 5; i++) await r.value.backstop();
            assert.equal(r.cycles(), cycles, 'EV_IDLE_NO_CYCLE an unchanged tenant runs no evaluation');
            assert.deepEqual([r.counters().passes, r.counters().checks, r.counters().unchanged], [5, 5, 5]);
            assert.equal(r.counters().stampReads, batch ? 5 : 0);
          } finally { await r.value.close(); }
        });
      });

      it('lost wake: the backstop finds a write that no wake announced, within one pass' + suffix, async function () {
        await lab.persistDomains({ entries: [reading('one', 111, -10 * 60000)] }); await lab.provisionView();
        await lab.at(at, async () => {
          const r = await runtime({ batch });
          try {
            await lab.persistDomains({ entries: [reading('two', 222)] }); // no wake
            assert.equal(r.mean(), 111, 'nothing evaluated before the backstop');
            await r.value.backstop();
            assert.equal(r.mean(), 222, 'EV_LOST_WAKE_BACKSTOP the write is evaluated by the next pass');
          } finally { await r.value.close(); }
        });
      });
    }

    it('duplicate delivery: the same stamp twice is one evaluation and one output revision', async function () {
      await lab.persistDomains({ entries: [reading('one', 111, -10 * 60000)] }); await lab.provisionView();
      await lab.at(at, async () => {
        const r = await runtime();
        try {
          const stamp = await lab.persistDomains({ entries: [reading('two', 222)] });
          const cycles = r.cycles(), revision = r.value.last(lab.A).outputRevision;
          await r.value.wake(lab.A, { stamp }); await r.value.wake(lab.A, { stamp });
          await r.value.wake(lab.A); await r.value.backstop(); // a hint without a stamp and a backstop pass, also duplicates
          assert.equal(r.cycles(), cycles + 1, 'EV_DUPLICATE_ONE_EVALUATION ' + JSON.stringify(r.counters()));
          assert.equal(r.value.last(lab.A).outputRevision, revision + 1, 'EV_DUPLICATE_ONE_REVISION');
          assert.equal(r.counters().duplicateWakes, 1);
          assert.equal(r.mean(), 222);
        } finally { await r.value.close(); }
      });
    });

    it('restart: a new runtime replays from the durable checkpoint and sees writes made while it was down', async function () {
      await lab.persistDomains({ entries: [reading('one', 111, -10 * 60000)] }); await lab.provisionView();
      await lab.at(at, async () => {
        const first = await runtime(); await first.value.close();
        await lab.persistDomains({ entries: [reading('two', 222)] });
        const again = await runtime();
        try { assert.equal(again.mean(), 222, 'EV_RESTART_REPLAYS'); } finally { await again.value.close(); }
      });
    });

    for (const batch of [false, true]) {
      it('a hard delete advances the write clock pair and is re-evaluated by the backstop' + (batch ? ' (one stamp read per pass)' : ''), async function () {
        await lab.persistDomains({ entries: [reading('one', 111, -10 * 60000), reading('two', 222)] }); await lab.provisionView();
        await lab.at(at, async () => {
          const r = await runtime({ batch });
          try {
            assert.equal(r.mean(), 222);
            const before = await lab.clock();
            await lab.hardDelete('entries', { _id: 'two' });
            const after = await lab.clock();
            assert.ok(after.stamp > before.stamp && after.deleted === after.stamp, 'premise: the hard delete advances last_stamp and last_delete_stamp');
            await r.value.backstop();
            assert.equal(r.mean(), 111, 'EV_HARD_DELETE_REEVALUATED');
            if (batch) assert.equal(r.reads.length, 1, 'one stamp read for the pass');
          } finally { await r.value.close(); }
        });
      });

      it('an in-place update to an unstamped domain advances the write clock and is re-evaluated by the backstop' + (batch ? ' (one stamp read per pass)' : ''), async function () {
        await lab.persistDomains({ entries: [reading('one', 111, -10 * 60000)], activity: [{ _id: 'steps', created_at: new Date(at - 60000).toISOString(), steps: 1 }] });
        await lab.provisionView();
        await lab.at(at, async () => {
          const r = await runtime({ batch });
          try {
            const cycles = r.cycles();
            await r.value.backstop(); assert.equal(r.cycles(), cycles, 'premise: unchanged');
            const before = await lab.clock();
            await lab.updateInPlace('activity', { _id: 'steps' }, { steps: 2 });
            const after = await lab.clock();
            assert.ok(after.stamp > before.stamp && after.deleted === before.deleted, 'premise: the update advances last_stamp only');
            await r.value.backstop();
            assert.equal(r.cycles(), cycles + 1, 'EV_UNSTAMPED_UPDATE_REEVALUATED');
            const saved = await lab.checkpointView(lab.A);
            assert.equal(saved.projection.find(row => row.domain === 'activity').doc.steps, 2);
          } finally { await r.value.close(); }
        });
      });
    }

    it('eviction releases the retained input and the next cycle reacquires the same output', async function () {
      await lab.persistDomains({ entries: [reading('one', 111, -10 * 60000)] }); await lab.provisionView();
      await lab.at(at, async () => {
        const timers = new Map(); let id = 0;
        const value = await startRuntime({ tenants: [lab.A], readCurrent: async tenant => ({ tenant, identity: 'e'.repeat(64) }),
          create: async () => lab.evaluator(lab.A), recoveryIntervalMs: 1000, timeIntervalMs: 60000, now: () => at, evictAfterMs: 1,
          schedule: () => 1, cancel () {}, setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimer: key => timers.delete(key) });
        try {
          const before = value.last(lab.A);
          const [key, evict] = [...timers][0]; timers.delete(key); evict.fn();
          assert.equal(value.health().tenants[0].evicted, true, 'EV_EVICTED');
          await value.tick(lab.A); // a due time on an evicted tenant
          assert.equal(value.health().tenants[0].evicted, false);
          assert.equal(value.last(lab.A).contentDigest, before.contentDigest, 'EV_EVICTION_SAME_OUTPUT');
          assert.equal(value.last(lab.A).trigger, 'acquisition');
        } finally { await value.close(); }
      });
    });
  });
