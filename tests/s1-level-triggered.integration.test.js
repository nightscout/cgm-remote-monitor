'use strict';

// Spike S1: level-triggered evaluator transport, api and evaluator in one
// process, no stream. Every accepted write must reach durable evaluator output
// inside the 120 s deadline. The oracle is independent of the mechanism: the
// completed output's bgnow.mills, read by the admin connection, must reach the
// written reading's date (each tenant's writes are sequential and newest-first,
// so a snapshot holding a later write holds every earlier one).
const assert = require('node:assert/strict');
const createLab = require('./fixtures/s1-level-lab');
const { optInSuite } = require('./support/opt-in');

const DEADLINE_MS = 120000;
const SWEEP_MS = Number(process.env.NS_S1_SWEEP_MS || 10000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function awaitReflected (lab, writes, { pollMs = 100 } = {}) {
  const pending = new Set(writes);
  while (pending.size) {
    const rows = await lab.outputs(), seen = Date.now();
    const last = new Map(rows.map(row => [row.tenant, row.last === null ? -1 : Number(row.last)]));
    for (const write of [...pending]) {
      if ((last.get(write.tenant) ?? -1) >= write.date) { write.latencyMs = seen - write.committedAt; pending.delete(write); }
      else if (seen - write.committedAt > DEADLINE_MS) { write.latencyMs = null; pending.delete(write); }
    }
    if (pending.size) await sleep(pollMs);
  }
  const missing = writes.filter(write => write.latencyMs === null);
  const latencies = writes.filter(write => write.latencyMs !== null).map(write => write.latencyMs);
  return { missing, maxLatencyMs: latencies.length ? Math.max(...latencies) : null, latencies };
}

// A reading dated now: bgnow reports only recent readings, so an older date
// would delay the oracle, not the evaluation. Per tenant the dates still rise.
async function write (lab, tenant, id, value, date = Date.now() - 1000) {
  await lab.writeDocs(tenant, 'entries', [lab.sgv(id, value, date)]);
  return { tenant, id, date, committedAt: Date.now() };
}

optInSuite(process.env.NS_S1_LEVEL_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_S1_LEVEL_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'S1 level-triggered transport: every accepted write reaches durable output on time', function () {
    this.timeout(DEADLINE_MS * 2 + 120000);
    const lab = createLab({ tenants: 2, audit: true });
    before(() => lab.open());
    beforeEach(() => lab.reset());
    after(() => lab.close());

    it('S1_C1_SWEEP_ALONE with every hint lost, the sweep delivers every write inside the deadline', async function () {
      await lab.startEvaluator({ sweepMs: SWEEP_MS, hints: false });
      const writes = [];
      for (let i = 0; i < 12; i++) {
        writes.push(await write(lab, i % 2 ? lab.base.B : lab.base.A, 'c1-' + i, 100 + i));
        await sleep(2000);
      }
      const result = await awaitReflected(lab, writes);
      console.log('S1_C1', JSON.stringify({ sweepMs: SWEEP_MS, maxLatencyMs: result.maxLatencyMs, latencies: result.latencies,
        hintsSent: lab.api.sent, hintsDropped: lab.api.dropped, sweep: lab.evaluator.sweepStats() }));
      assert.equal(lab.api.sent, 0, 'no hint reached the evaluator');
      assert.deepEqual(result.missing.map(w => w.id), [], 'S1_C1_WRITE_MISSING_OR_LATE');
      assert.ok(result.maxLatencyMs <= DEADLINE_MS);
    });

    it('S1_C2_LOST_HINT a write whose hint is lost (crash after COMMIT) is still evaluated, from its pending mark', async function () {
      await lab.startEvaluator({ sweepMs: SWEEP_MS, hints: true });
      const writes = [];
      writes.push(await write(lab, lab.base.A, 'c2-a0', 120));
      lab.api.drop.add(lab.base.B);
      const lost = await write(lab, lab.base.B, 'c2-b-lost', 130);
      lab.api.drop.delete(lab.base.B);
      writes.push(lost);
      writes.push(await write(lab, lab.base.A, 'c2-a1', 121));
      const result = await awaitReflected(lab, writes);
      console.log('S1_C2', JSON.stringify({ sweepMs: SWEEP_MS, lostLatencyMs: lost.latencyMs, latencies: result.latencies,
        hintsSent: lab.api.sent, hintsDropped: lab.api.dropped, sweep: lab.evaluator.sweepStats() }));
      assert.equal(lab.api.dropped, 1);
      assert.deepEqual(result.missing.map(w => w.id), [], 'S1_C2_LOST_HINT_WRITE_MISSING_OR_LATE');
    });

    it('S1_C3_RESTORE_FENCE no output computed before a restore is committed across it; a stale hint is refused', async function () {
      const A = lab.base.A;
      let hold = false, held, release;
      const gate = async tenant => {
        if (!hold || tenant !== A) return;
        hold = false;
        const released = new Promise(resolve => { release = resolve; });
        held();
        await released;
      };
      const evaluator = await lab.startEvaluator({ sweepMs: SWEEP_MS, hints: true, gate, retryMs: 500 });
      const first = await write(lab, A, 'c3-w1', 140, Date.now() - 2000);
      assert.deepEqual((await awaitReflected(lab, [first])).missing, []);
      const before = (await lab.outputs()).find(row => row.tenant === A);
      assert.equal(before.generation, '1');
      // A cycle at generation 1 holds after its window read (w2 visible).
      const isHeld = new Promise(resolve => { held = resolve; });
      hold = true;
      await write(lab, A, 'c3-w2', 150, Date.now() - 1000);
      await isHeld;
      // The restore commits (generation 2, w2 absent) while that cycle is held.
      const generation = await lab.restore(A, { removeEntriesAfter: first.date });
      const auditAtRestore = await lab.auditMark();
      const revisionAtRestore = Number((await lab.outputs()).find(row => row.tenant === A).revision);
      const crossed = [];
      let watching = true;
      const watch = (async () => {
        while (watching) {
          const row = (await lab.outputs()).find(r => r.tenant === A);
          if (row.generation !== generation && row.generation !== before.generation) crossed.push(row);
          await sleep(20);
        }
      })();
      release();
      // The generation-2 output: w1 only.
      const deadline = Date.now() + DEADLINE_MS;
      let after;
      do { await sleep(100); after = (await lab.outputs()).find(row => row.tenant === A); }
      while (!(after.generation === generation && after.pending === null) && Date.now() < deadline);
      watching = false; await watch;
      // A hint carrying the old generation, after the evaluator completed at the new one.
      const staleBefore = evaluator.stats.staleHints, runsBefore = evaluator.stats.runs;
      evaluator.hint({ tenant: A, generation: '1' });
      await sleep(1500);
      const final = (await lab.outputs()).find(row => row.tenant === A);
      // Every revision committed after the restore, from the audit trigger.
      const committed = await lab.audit(A, auditAtRestore);
      crossed.push(...committed.filter(row => row.generation !== generation));
      console.log('S1_C3', JSON.stringify({ generation, revisionAtRestore, after, final, committed, crossed, stats: evaluator.stats }));
      assert.deepEqual(crossed, [], 'S1_C3_OUTPUT_CROSSED_RESTORE');
      assert.equal(after.generation, generation, 'S1_C3_NEW_GENERATION_OUTPUT_MISSING');
      assert.equal(Number(after.last), first.date, 'S1_C3_RESTORED_STATE_NOT_EVALUATED');
      assert.ok(committed.length >= 1 && committed.at(-1).generation === generation, 'S1_C3_NO_OUTPUT_AT_NEW_GENERATION');
      assert.ok(evaluator.stats.refused >= 1, 'S1_C3_FENCE_NOT_EXERCISED');
      assert.equal(evaluator.stats.staleHints, staleBefore + 1, 'S1_C3_STALE_HINT_ACCEPTED');
      assert.equal(evaluator.stats.runs, runsBefore, 'S1_C3_STALE_HINT_RAN');
      assert.equal(final.revision, after.revision);
    });

    it('S1_X_HARD_DELETE a hard delete (no clock stamp) is evaluated from its pending mark', async function () {
      await lab.startEvaluator({ sweepMs: SWEEP_MS, hints: false });
      const older = await write(lab, lab.base.A, 'x-older', 110, Date.now() - 2000);
      const newer = await write(lab, lab.base.A, 'x-newer', 111, Date.now() - 1000);
      assert.deepEqual((await awaitReflected(lab, [older, newer])).missing, []);
      const clockBefore = await lab.base.clock();
      await lab.hardDelete(lab.base.A, 'entries', 'x-newer');
      assert.deepEqual(await lab.base.clock(), clockBefore, 'the hard delete took no clock stamp');
      const deadline = Date.now() + DEADLINE_MS; let row;
      do { await sleep(100); row = (await lab.outputs()).find(r => r.tenant === lab.base.A); } while (Number(row.last) !== older.date && Date.now() < deadline);
      assert.equal(Number(row.last), older.date, 'S1_X_HARD_DELETE_NOT_EVALUATED');
    });
  });
