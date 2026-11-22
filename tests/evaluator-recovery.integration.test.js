'use strict';
// Evaluator recovery fault points on the actual role process over actual PostgreSQL, on the
// writer-driven input transport (the only one; decision writer-driven-transport-direction).
// The api write marks the evaluator's completed-work row pending in its own transaction; the role
// recomputes from that durable mark (startup sweep, periodic sweep, disposable hint). Replaces the
// retired stream recovery suite (E6): the fault points that are still in force are ported here.
// Synthetic tenants and readings only.
// covers: lib/server/serve/evaluator-runtime.js, lib/server/serve/evaluator-preview.js, lib/pgstream/activity-scheduler.js, lib/writer-driven/index.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { optInSuite } = require('./support/opt-in');
const decorate = require('../lib/storage/postgres-write-clock');
const work = require('../lib/pgstream/work-state');
const enabled = process.env.NS_EVALUATOR_RECOVERY_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI;
// Control (measurement rule 3): NS_EVALUATOR_LAB_CONTROL=no-mark makes the lab's writers skip the pending mark,
// so no write is owed and the recovery criteria below must go red.

optInSuite(enabled, 'NS_EVALUATOR_RECOVERY_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'actual role writer-driven recovery fault points', function () {
    this.timeout(60000);
    const lab = require('./fixtures/evaluator-preview-registry-lab')();
    before(() => lab.open());
    beforeEach(() => lab.reset());
    after(() => lab.close());
    const floor = value => BigInt(value || '0');
    function identity (pid) {
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      return { pid, group: Number(fields[2]), session: Number(fields[3]), birth: fields[19] };
    }
    async function wait (check, milliseconds, symptom) {
      const end = performance.now() + milliseconds;
      while (performance.now() < end) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error(symptom);
    }
    async function startExisting (config, options, tenants = [lab.A]) {
      const worker = await lab.worker(config, options);
      assert.equal(worker.startup.ready, true, JSON.stringify(worker.startup));
      for (const tenant of tenants) await worker.call('acquire', tenant);
      return worker;
    }
    async function write (value, id = 'synthetic-recovery', age = 1000, tenant = lab.A) {
      const at = Date.now();
      return lab.persistDomains({ entries: [{ _id: id, type: 'sgv', sgv: value, date: at - age, dateString: new Date(at - age).toISOString(), direction: 'Flat' }] }, tenant);
    }
    // The write clock's committed stamp is the version the pending mark carries.
    const stampOf = async (tenant = lab.A) => floor((await lab.clock(tenant)).stamp);
    async function state (tenant = lab.A) {
      const rows = (await lab.admin.query('SELECT work_observed,work_completed,work_pending_at,work_due_at::text AS due_at,work_completed_at::text AS completed_at FROM "' + lab.replayNamespace +
        '".tenant_consumer_checkpoint WHERE tenant_id=$1 AND consumer=$2', [tenant, lab.consumerName + '-completed'])).rows;
      assert.equal(rows.length, 1, 'ONE_DURABLE_WORK_ROW');
      return { ...rows[0], observed: work.map(rows[0].work_observed), completed: work.map(rows[0].work_completed) };
    }
    const covers = async (stamp, tenant = lab.A) => floor((await state(tenant)).completed.clock) >= stamp;
    const frameValue = async (id, tenant = lab.A) => (await lab.previewCompleted(tenant)).projection[0].output.frame.sgvs.find(row => row._id === id)?.mgdl;
    async function firstUsefulOutput (worker, expected) {
      await wait(async () => {
        for (const wanted of expected) {
          const row = await state(wanted.tenant);
          if (await frameValue(wanted.id, wanted.tenant) !== wanted.value || row.work_pending_at !== null || !(await worker.call('last', wanted.tenant))?.eligible) return false;
        }
        return true;
      }, 15000, 'FIRST_USEFUL_OUTPUT');
    }
    async function holdNext (worker, value) {
      const nonce = crypto.randomUUID(), holding = worker.held();
      await worker.call('arm', lab.A, { hold: { nonce, expected: { id: 'synthetic-recovery', value } } });
      await write(value);
      let timer;
      const signal = await Promise.race([holding, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('ACTUAL_CLINICAL_CYCLE_MUST_REACH_HOLD')), 8000); })]).finally(() => clearTimeout(timer));
      assert.equal(signal.tenant, lab.A, 'HOLD_MUST_NAME_THE_SELECTED_TENANT');
      assert.equal(signal.nonce, nonce, 'HOLD_MUST_NAME_THE_CURRENT_ARM');
      const stamp = await stampOf(), held = await state();
      assert(floor(held.observed.clock) >= stamp, 'PENDING_MARK_DURABLE_BEFORE_CLINICAL_HOLD');
      assert(floor(held.completed.clock) < stamp, 'HELD_CYCLE_MUST_NOT_COMPLETE');
      return stamp;
    }
    async function killWorker (worker) {
      assert.equal(worker.child.exitCode, null); assert.equal(worker.child.signalCode, null);
      const current = identity(worker.child.pid);
      assert.equal(current.birth, worker.birth, 'OWNED_ROLE_BIRTH_BEFORE_KILL');
      assert.equal(current.group, worker.processGroup, 'OWNED_ROLE_GROUP_BEFORE_KILL');
      const exited = new Promise(resolve => worker.child.once('exit', (code, signal) => resolve({ code, signal })));
      process.kill(-worker.processGroup, 'SIGKILL');
      const result = await exited; assert.equal(result.signal, 'SIGKILL'); return result;
    }
    async function inputBookend () {
      const rows = [];
      for (const tenant of [lab.A, lab.B]) rows.push({ tenant, clock: await lab.clock(tenant), tables: (await lab.physical(tenant)).tables });
      return rows;
    }

    it('lets an unrelated tenant complete newly arriving input while the first tenant is held', async function () {
      await write(110);
      await write(210, 'neighbor', 1000, lab.B);
      const worker = await startExisting(lab.configure(), { detached: true }, [lab.A, lab.B]);
      try {
        await firstUsefulOutput(worker, [{ tenant: lab.A, id: 'synthetic-recovery', value: 110 }, { tenant: lab.B, id: 'neighbor', value: 210 }]);
        const held = await holdNext(worker, 131);
        await write(241, 'neighbor', 0, lab.B);
        const stamp = await stampOf(lab.B);
        await wait(() => covers(stamp, lab.B), 8000, 'IDLE_SLOT_MUST_COMPLETE_NEIGHBOR_BEFORE_HELD_TENANT_RELEASE');
        assert.equal(await frameValue('neighbor', lab.B), 241);
        assert(floor((await state()).completed.clock) < held, 'HELD_TENANT_MUST_REMAIN_UNFINISHED');
        await worker.call('release');
        await wait(() => covers(held), 8000, 'HELD_TENANT_MUST_RESUME');
      } finally { await worker.call('release'); await lab.stopWorker(worker); }
    });

    it('retains a newer pending mark across a held completion and recovers pending clinical work after actual role process-group death', async function () {
      await write(110);
      const config = lab.configure(), worker = await startExisting(config, { detached: true });
      await firstUsefulOutput(worker, [{ tenant: lab.A, id: 'synthetic-recovery', value: 110 }]);
      await holdNext(worker, 130);
      await write(149); const newer = await stampOf();
      assert(floor((await state()).observed.clock) >= newer, 'NEWER_MARK_MUST_COMMIT_WHILE_OLDER_CYCLE_HELD');
      await worker.call('release');
      await wait(() => covers(newer), 12000, 'NEWER_MARK_MUST_REMAIN_PENDING_UNTIL_COMPLETED');
      assert.equal(await frameValue('synthetic-recovery'), 149);
      const pending = await holdNext(worker, 171), held = await state(), clockBefore = (await lab.clock()).stamp, inputBefore = await inputBookend();
      assert(Number(held.work_pending_at) > 0, 'PENDING_AGE_ORIGIN_MUST_BE_DURABLE');
      await killWorker(worker);
      const next = await lab.worker(config, { detached: true });
      try {
        assert.equal(next.startup.ready, true, 'RESTARTED_ACTUAL_ROLE_READY');
        // No input write and no hint: the startup sweep over pending rows owes and completes it.
        await wait(() => covers(pending), 15000, 'PROCESS_LOSS_MUST_RECOVER_DURABLE_PENDING');
        assert.equal(await frameValue('synthetic-recovery'), 171);
        assert.equal((await lab.clock()).stamp, clockBefore, 'RESTART_RECOVERY_NEEDS_NO_INPUT_WRITE');
        assert.deepEqual(await inputBookend(), inputBefore, 'PENDING_RESTART_PHYSICAL_INPUT_AND_CLOCK_BOOKENDS_UNCHANGED');
        assert.equal((await state()).work_pending_at, null);
      } finally { await lab.stopWorker(next); }
    });

    it('preserves completed output across process death and fires recovered future clinical due work without a new input write', async function () {
      await lab.setSettings({ enable: ['bgnow', 'delta', 'direction', 'simplealarms'] });
      await write(50, 'synthetic-recovery', 600000 - 15000);
      const config = lab.configure(), worker = await startExisting(config, { detached: true });
      await firstUsefulOutput(worker, [{ tenant: lab.A, id: 'synthetic-recovery', value: 50 }]);
      const before = await state(), outputBefore = await lab.previewCompleted(), clockBefore = (await lab.clock()).stamp, inputBefore = await inputBookend();
      assert(Number(before.due_at) - Date.now() > 2000, 'FUTURE_DUE_RESTART_FIXTURE_NEEDS_TWO_SECONDS_BUDGET');
      assert(Number(before.due_at) - Date.now() < 20000, 'BOUNDED_SYNTHETIC_DUE_REQUIRED');
      await killWorker(worker);
      const next = await lab.worker(config, { detached: true });
      try {
        assert.equal(next.startup.ready, true);
        const resumed = await lab.previewCompleted();
        if (Number(resumed.projection[0].output.result.now) < Number(before.due_at)) assert.equal(resumed.output_revision, outputBefore.output_revision, 'PRE_DUE_COMMITTED_CONTENT_MUST_NOT_DUPLICATE_REVISION_AFTER_DEATH');
        await wait(async () => {
          const current = await state(), output = await lab.previewCompleted();
          return Number(current.completed_at) >= Number(before.due_at) && Number(output.projection[0].output.result.now) >= Number(before.due_at);
        }, 30000, 'RESTARTED_ROLE_MUST_FIRE_RECOVERED_DUE_WORK');
        assert.equal((await lab.clock()).stamp, clockBefore, 'TIME_WORK_MUST_NOT_REQUIRE_OR_CREATE_INPUT_WRITE');
        assert.equal((await state()).work_pending_at, null);
        assert.deepEqual(await inputBookend(), inputBefore, 'DUE_RESTART_PHYSICAL_INPUT_AND_CLOCK_BOOKENDS_UNCHANGED');
      } finally { await lab.stopWorker(next); }
    });

    it('completes an unstamped activity write from its pending mark without changing public history; an unmarked write is never owed', async function () {
      await write(110);
      const worker = await startExisting(lab.configure(), { detached: true });
      const id = 'unstamped-activity', publicClock = await lab.clock();
      const activity = (steps, op) => lab.writeCanonical({ logical: 'activity', planned: op === 'create'
        ? { op, docs: [{ _id: id, steps, created_at: new Date().toISOString() }] } : { op, form: 'merge', target: { _id: id }, fields: { steps } } });
      const observedClock = async () => floor((await state()).observed.clock);
      try {
        await firstUsefulOutput(worker, [{ tenant: lab.A, id: 'synthetic-recovery', value: 110 }]);
        const before = await lab.previewCompleted(), foreign = await lab.previewCompleted(lab.B), seed = await observedClock();
        await activity(1, 'create');
        await wait(async () => (await observedClock()) > seed && (await state()).work_pending_at === null && floor((await state()).completed.clock) >= (await observedClock()), 15000, 'UNSTAMPED_ACTIVITY_CREATE_NOT_COMPLETED');
        const created = await observedClock();
        // Control (red): a writer that does not mark leaves nothing owed; the role is never told.
        const marked = lab.clocks[0];
        lab.clocks[0] = decorate(lab.raw[0], lab.namespaces.clock);
        try { await activity(2, 'update'); } finally { lab.clocks[0] = marked; }
        await new Promise(resolve => setTimeout(resolve, 1500));
        assert.equal(await observedClock(), created, 'UNMARKED_WRITE_IS_NOT_OWED');
        // Restored (green): the marked write completes.
        await activity(3, 'update');
        await wait(async () => (await observedClock()) > created && (await state()).work_pending_at === null && floor((await state()).completed.clock) >= (await observedClock()), 15000, 'UNSTAMPED_ACTIVITY_UPDATE_NOT_COMPLETED');
        const physical = (await lab.physical()).tables.activity.find(row => row.doc._id === id);
        assert.equal(physical.doc.steps, 3, 'UNSTAMPED_ACTIVITY_ACTUAL_UPDATE_COMMITTED');
        assert.equal(Object.hasOwn(physical.doc, 'srvModified'), false, 'UNSTAMPED_ACTIVITY_HAS_NO_HISTORY_STAMP');
        const after = await lab.previewCompleted();
        assert.deepEqual(await lab.clock(), publicClock, 'UNSTAMPED_ACTIVITY_PUBLIC_HISTORY_UNCHANGED');
        assert.equal(after.output_revision, before.output_revision, 'UNCHANGED_CLINICAL_CONTENT_KEEPS_REVISION');
        assert.deepEqual(await lab.previewCompleted(lab.B), foreign, 'UNSTAMPED_ACTIVITY_FOREIGN_TENANT_UNCHANGED');
      } finally { await lab.stopWorker(worker); }
    });

    it('refuses a held completion after an actual lifecycle generation advance and keeps a healthy neighbour progressing', async function () {
      await write(110); await write(210, 'generation-neighbor', 1000, lab.B);
      const worker = await startExisting(lab.configure(), { detached: true }, [lab.A, lab.B]);
      const table = '"' + lab.registryNamespaces.control + '".tenant_lifecycle_windows'; let advanced = false;
      try {
        await firstUsefulOutput(worker, [{ tenant: lab.A, id: 'synthetic-recovery', value: 110 }, { tenant: lab.B, id: 'generation-neighbor', value: 210 }]);
        const target = await holdNext(worker, 181), before = await lab.previewCompleted();
        const failedBefore = (await worker.call('health')).tenants.find(row => row.tenant === lab.A).progress.failedCompletions;
        await lab.admin.query('UPDATE ' + table + " SET phase='suspended',generation=generation+1,claim_id=$2,artifact_digest=$3 WHERE tenant_id=$1", [lab.A, crypto.randomUUID(), 'a'.repeat(64)]); advanced = true;
        await worker.call('release');
        await wait(async () => (await worker.call('health')).tenants.find(row => row.tenant === lab.A).progress.failedCompletions > failedBefore, 8000, 'STALE_GENERATION_COMPLETION_MUST_BE_REFUSED');
        assert(floor((await state()).completed.clock) < target, 'OLD_GENERATION_INPUT_MUST_NOT_BE_CERTIFIED');
        assert.equal((await lab.previewCompleted()).output_revision, before.output_revision, 'OLD_GENERATION_MUST_NOT_PUBLISH');
        await write(241, 'generation-neighbor', 0, lab.B);
        const neighbor = await stampOf(lab.B);
        await wait(() => covers(neighbor, lab.B), 12000, 'SUSPENDED_NEIGHBOR_MUST_NOT_BLOCK_HEALTHY_TENANT');
      } finally {
        await worker.call('release'); await lab.stopWorker(worker);
        if (advanced) await lab.admin.query('UPDATE ' + table + " SET phase='active',claim_id=NULL,artifact_digest=NULL WHERE tenant_id=$1", [lab.A]);
      }
    });
  });
