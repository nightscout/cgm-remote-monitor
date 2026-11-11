'use strict';

// Work on change (decision cost-proportional-to-activity, D6): the actual
// runtime and evaluator component over actual PostgreSQL, with the backstop
// pass and the due timers driven by the test instead of wall-clock timers.
// The durable-event contract's controls: lost wake, duplicate delivery,
// restart replay; and the change signature's coverage of hard deletes and
// unstamped writes, which do not advance the tenant write clock.
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
    async function runtime () {
      const passes = [], timers = new Map(); let id = 0;
      const value = await startRuntime({ tenants: [lab.A], readCurrent: async tenant => ({ tenant, identity: 'e'.repeat(64) }),
        create: async () => lab.evaluator(lab.A), recoveryIntervalMs: 1000, timeIntervalMs: 60000, now: () => at,
        schedule: fn => { passes.push(fn); return passes.length; }, cancel () {},
        setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimer: key => timers.delete(key) });
      return { value, timers, cycles: () => value.health().tenants[0].cycles, mean: () => value.last(lab.A)?.result.properties.bgnow?.mean ?? null,
        counters: () => value.health().wake };
    }
    const table = logical => '"' + lab.namespaces[logical] + '"."' + logical + '"';

    it('an unchanged tenant costs one signature read per pass and no cycle', async function () {
      await lab.persistDomains({ entries: [reading('one', 111, -10 * 60000)] }); await lab.provisionView();
      await lab.at(at, async () => {
        const r = await runtime();
        try {
          assert.equal(r.mean(), 111); const cycles = r.cycles();
          for (let i = 0; i < 5; i++) await r.value.backstop();
          assert.equal(r.cycles(), cycles, 'EV_IDLE_NO_CYCLE an unchanged tenant runs no evaluation');
          assert.deepEqual([r.counters().passes, r.counters().checks, r.counters().unchanged], [5, 5, 5]);
        } finally { await r.value.close(); }
      });
    });

    it('lost wake: the backstop finds a write that no wake announced, within one pass', async function () {
      await lab.persistDomains({ entries: [reading('one', 111, -10 * 60000)] }); await lab.provisionView();
      await lab.at(at, async () => {
        const r = await runtime();
        try {
          await lab.persistDomains({ entries: [reading('two', 222)] }); // no wake
          assert.equal(r.mean(), 111, 'nothing evaluated before the backstop');
          await r.value.backstop();
          assert.equal(r.mean(), 222, 'EV_LOST_WAKE_BACKSTOP the write is evaluated by the next pass');
        } finally { await r.value.close(); }
      });
    });

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

    it('a hard delete, which does not advance the write clock, is re-evaluated by the backstop', async function () {
      await lab.persistDomains({ entries: [reading('one', 111, -10 * 60000), reading('two', 222)] }); await lab.provisionView();
      await lab.at(at, async () => {
        const r = await runtime();
        try {
          assert.equal(r.mean(), 222);
          const floor = await lab.admin.query('SELECT last_stamp FROM "' + lab.namespaces.clock + '".tenant_write_clock WHERE tenant_id=$1', [lab.A]);
          await lab.admin.query('DELETE FROM ' + table('entries') + " WHERE tenant_id=$1 AND doc->>'_id'='two'", [lab.A]);
          const after = await lab.admin.query('SELECT last_stamp FROM "' + lab.namespaces.clock + '".tenant_write_clock WHERE tenant_id=$1', [lab.A]);
          assert.equal(after.rows[0].last_stamp, floor.rows[0].last_stamp, 'premise: the hard delete leaves the floor unchanged');
          await r.value.backstop();
          assert.equal(r.mean(), 111, 'EV_HARD_DELETE_REEVALUATED');
        } finally { await r.value.close(); }
      });
    });

    it('an unstamped in-place update (same row count, same floor) is re-evaluated by the backstop', async function () {
      await lab.persistDomains({ entries: [reading('one', 111, -10 * 60000)], activity: [{ _id: 'steps', created_at: new Date(at - 60000).toISOString(), steps: 1 }] });
      await lab.provisionView();
      await lab.at(at, async () => {
        const r = await runtime();
        try {
          const cycles = r.cycles();
          await r.value.backstop(); assert.equal(r.cycles(), cycles, 'premise: unchanged');
          // An activity write without a server stamp: same floor, same row count.
          await lab.admin.query('UPDATE ' + table('activity') + " SET doc = jsonb_set(doc, '{steps}', '2') WHERE tenant_id=$1 AND doc->>'_id'='steps'", [lab.A]);
          await r.value.backstop();
          assert.equal(r.cycles(), cycles + 1, 'EV_UNSTAMPED_UPDATE_REEVALUATED');
          const saved = await lab.checkpointView(lab.A);
          assert.equal(saved.projection.find(row => row.domain === 'activity').doc.steps, 2);
        } finally { await r.value.close(); }
      });
    });

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
