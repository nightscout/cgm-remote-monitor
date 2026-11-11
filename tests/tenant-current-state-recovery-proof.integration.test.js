'use strict';

// Bounded current-state recovery. Historical0bc characterization/captures stay immutable.
// No retained-transition, distributed-runtime or notification acceptance here.
const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const { ObjectId } = require('mongodb');
const createLab = require('./fixtures/m5-current-state-proof');
const { optInSuite } = require('./support/opt-in');

const at = Date.UTC(2026, 10, 6, 12);
const older = 'm5-current-string';
const newer = '0123456789abcdef01234567';
const reading = (id, sgv, minutes) => ({ _id: id, type: 'sgv', sgv,
  date: at - minutes * 60000, dateString: new Date(at - minutes * 60000).toISOString(), direction: 'Flat' });
const mean = observation => observation?.properties?.bgnow?.mean;
function committed(write) {
  assert.equal(write.commits.length, 1, 'M5_COMMIT actual transaction receipt');
  assert.equal(write.commits[0].status, 'committed', 'M5_COMMIT independent transaction status');
  assert.equal(write.commits[0].earlyEvents, 0, 'M5_COMMIT no intent publication before COMMIT');
  assert.equal(write.events.length, 1, 'M5_COMMIT canonical committed intent event');
  assert.equal(write.events[0].committedReceipts, 1, 'M5_COMMIT publication follows checked COMMIT');
}
function parity(observation, label) {
  assert.deepEqual(observation.projectionKeys, observation.physical && Object.entries(observation.physical.tables)
    .flatMap(([domain, rows]) => rows.filter(row => row.doc.isValid !== false)
      .map(row => JSON.stringify([domain, row.id_kind, row.doc._id]))).sort(), label + ' typed physical identities');
  assert.deepEqual(observation.clinical.properties, observation.fresh.properties, label + ' independent clinical output');
}

optInSuite(process.env.NS_M5_CURRENT_STATE_PROOF_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_M5_CURRENT_STATE_PROOF_TEST=1 with disposable PostgreSQL')(
  'M5 bounded current-state snapshot recovery', function () {
    this.timeout(60000);
    const lab = createLab();
    before(() => lab.open());
    beforeEach(() => lab.reset());
    after(() => lab.close());

    it('reconciles canonical hard-delete absence across unchanged floor restart and later advancement', async function () {
      // Socket dbAdd is one canonical record per write, as its real caller is.
      const seeded = await lab.writeCanonical({ planned: { op: 'create', docs: [
        { ...reading(older, 111, 7), identifier: older }
      ] } });
      const seededNewest = await lab.writeCanonical({ planned: { op: 'create', docs: [reading(new ObjectId(newer), 222, 2)] } });
      const seededB = await lab.writeCanonical({ tenant: lab.B, planned: { op: 'create', docs: [reading(new ObjectId(newer), 333, 2)] } });
      lab.trace('initial-canonical-writes', { seeded, seededNewest, seededB });
      committed(seeded); committed(seededNewest); committed(seededB);
      assert.deepEqual(seededNewest.after.tables.entries.map(row => row.id_kind).sort(), ['objectid', 'string']);
      await lab.provisionView();
      const initial = lab.trace('initial-catchup-clinical', await lab.compare(at));
      parity(initial, 'M5_INITIAL');
      assert.equal(mean(initial.clinical), 222, 'M5_INITIAL clinical newest reading');
      const foreign = initial.foreign;
      const deleted = await lab.writeCanonical({ planned: { op: 'delete', target: { _id: new ObjectId(newer) } } });
      lab.trace('canonical-hard-delete', { deleted });
      committed(deleted);
      assert.equal(deleted.after.tables.entries.length, 1, 'M5_HARD_DELETE physical removal reached');
      assert.deepEqual(deleted.after.tables.entries.map(row => [row.id_kind, row.doc._id, row.doc.sgv]),
        [['string', older, 111]], 'M5_HARD_DELETE typed survivor is independent of the removed ObjectId');
      assert.ok(deleted.after.tables.entries.every(row => row.doc._id !== newer), 'M5_HARD_DELETE independent physical absence');
      // Decision write-clock-complete: a hard delete advances the durable floor
      // and carries its commit stamp (before the decision: unchanged floor, null stamp).
      assert.ok(deleted.after.floor > deleted.before.floor, 'M5_HARD_DELETE_CLOCK durable floor advances');
      assert.equal(deleted.events[0].event.stamp, deleted.after.floor, 'M5_HARD_DELETE_CLOCK event carries the commit stamp');
      const stale = lab.trace('after-delete-catchup-new-handle', await lab.compare(at));
      assert.equal(stale.clinical.checkpoint, deleted.after.floor);
      const absentKey = JSON.stringify(['entries', 'objectid', newer]);
      assert.ok(!stale.projectionKeys.includes(absentKey), 'M5_SNAPSHOT_ABSENCE removed typed key must be absent');
      assert.equal(stale.projectionKeys.length, 1, 'M5_SNAPSHOT_ABSENCE full current identity replacement');
      assert.equal(mean(stale.clinical), 111, 'M5_SNAPSHOT_ABSENCE actual recovered clinical output');
      assert.equal(mean(stale.fresh), 111, 'M5_HARD_DELETE independent current-table clinical oracle');
      parity(stale, 'M5_SNAPSHOT_ABSENCE');
      assert.deepEqual(stale.foreign, foreign, 'M5_TENANT foreign stored values/floor/checkpoint unchanged');
      const restarted = lab.trace('restart-with-no-new-floor', await lab.compare(at));
      assert.deepEqual(restarted.projectionKeys, stale.projectionKeys);
      assert.equal(mean(restarted.clinical), 111);
      assert.equal(mean(restarted.fresh), 111);

      const unrelated = await lab.writeCanonical({ source: 'v1/internal',
        planned: { op: 'create', docs: [reading('m5-unrelated-advance', 98, 30)] } });
      lab.trace('unrelated-canonical-stamped-write', { unrelated });
      committed(unrelated);
      assert.ok(unrelated.after.floor > deleted.after.floor, 'M5_ADVANCE actual unrelated floor advancement');
      const advanced = lab.trace('advanced-checkpoint-new-handle', await lab.compare(at));
      assert.equal(advanced.clinical.checkpoint, unrelated.after.floor);
      assert.equal(advanced.physical.tables.entries.length, 2);
      assert.ok(!advanced.projectionKeys.includes(absentKey));
      assert.equal(advanced.projectionKeys.length, 2, 'M5_SNAPSHOT_ADVANCE no absent key after later floor');
      assert.equal(mean(advanced.clinical), 111);
      parity(advanced, 'M5_SNAPSHOT_ADVANCE');
      assert.equal(mean(advanced.fresh), 111);
      assert.deepEqual(advanced.foreign, foreign);

      const marked = await lab.writeCanonical({ source: 'v3', planned: { op: 'delete', form: 'mark', target: { identifier: older } } });
      lab.trace('canonical-soft-delete', { marked });
      committed(marked);
      assert.ok(marked.after.floor > marked.before.floor, 'M5_SOFT_DELETE floor advances');
      const markedRow = marked.after.tables.entries.find(row => row.doc._id === older);
      assert.ok(markedRow, 'M5_SOFT_DELETE independent retained row exists');
      assert.equal(markedRow.doc.isValid, false);
      const soft = lab.trace('soft-delete-positive', await lab.compare(at));
      parity(soft, 'M5_SOFT_DELETE');
      assert.equal(soft.projectionKeys.length, 1, 'M5_SOFT_DELETE invalid key removed');
      assert.deepEqual(soft.foreign, foreign);
    });

    for (const source of ['v1/internal', 'socket']) {
      it('reconciles dates:none activity create and unchanged-floor update from ' + source, async function () {
        await lab.provisionView();
        const before = await lab.physical();
        const foreign = await lab.physical(lab.B);
        const doc = { _id: new ObjectId('1234567890abcdef12345678'),
          created_at: new Date(at).toISOString(), date: at, steps: 1 };
        const created = await lab.writeCanonical({ logical: 'activity', source, planned: { op: 'create', docs: [doc] } });
        const initial = await lab.compare(at);
        const checkpointBeforeStrict = await lab.checkpointView(lab.A);
        const firstAttempt = await lab.replayAttempt();
        lab.trace('activity-created-' + source, { created, initial, firstAttempt, physical: await lab.physical(), foreign: await lab.physical(lab.B) });
        committed(created);
        assert.equal(created.after.tables.activity.length, 1, 'M5_ACTIVITY physical create reached');
        // Decision write-clock-complete: an activity write advances the floor
        // although the row itself carries no srvModified (dates:none).
        assert.ok(created.after.floor > before.floor, 'M5_ACTIVITY_CLOCK floor advances');
        assert.equal(created.events[0].event.stamp, created.after.floor, 'M5_ACTIVITY_CLOCK event carries the commit stamp');
        assert.equal(Object.hasOwn(created.after.tables.activity[0].doc, 'srvModified'), false);
        assert.equal(firstAttempt.error && firstAttempt.error.name, 'Error', 'M5_ACTIVITY wrong failure layer is invalid');
        assert.equal(firstAttempt.error.message, 'REPLAY_UNSTAMPED_OR_UNFENCED_ROW', 'M5_ACTIVITY_HYPOTHESIS exact replay refusal');
        parity(initial, 'M5_SNAPSHOT_ACTIVITY_CREATE');
        assert.equal(initial.recovered.rows.find(row => row.domain === 'activity').doc.steps, 1);
        assert.deepEqual(await lab.checkpointView(lab.A), checkpointBeforeStrict, 'M5_ACTIVITY strict replay refusal commits no checkpoint');
        const changed = source === 'socket'
          ? { op: 'update', form: 'merge', target: { _id: doc._id }, fields: { steps: 2 } }
          : { op: 'update', docs: [{ ...doc, steps: 2 }] };
        const updated = await lab.writeCanonical({ logical: 'activity', source, planned: changed });
        const recovered = await lab.compare(at);
        const checkpointAfterUpdate = await lab.checkpointView(lab.A);
        const secondAttempt = await lab.replayAttempt();
        const final = lab.trace('activity-updated-' + source, { updated, recovered, secondAttempt,
          physical: await lab.physical(), foreign: await lab.physical(lab.B) });
        committed(updated);
        assert.equal(final.physical.tables.activity.length, 1);
        assert.equal(final.physical.tables.activity[0].doc.steps, 2, 'M5_ACTIVITY independent physical update reached');
        assert.ok(final.physical.floor > created.after.floor, 'M5_ACTIVITY_CLOCK update advances the floor');
        assert.equal(Object.hasOwn(final.physical.tables.activity[0].doc, 'srvModified'), false);
        assert.equal(updated.events[0].event.stamp, final.physical.floor);
        assert.equal(secondAttempt.error && secondAttempt.error.name, 'Error');
        assert.equal(secondAttempt.error.message, 'REPLAY_UNSTAMPED_OR_UNFENCED_ROW');
        parity(recovered, 'M5_SNAPSHOT_ACTIVITY_UPDATE');
        assert.equal(recovered.recovered.rows.find(row => row.domain === 'activity').doc.steps, 2, 'M5_SNAPSHOT_ACTIVITY_UPDATE actual unstamped update retained');
        // The update advanced the floor, so the snapshot's checkpoint follows it.
        assert.equal(recovered.clinical.checkpoint, final.physical.floor, 'M5_ACTIVITY_CLOCK checkpoint follows the advanced floor');
        assert.deepEqual(final.physical.checkpoint, checkpointAfterUpdate);
        assert.deepEqual(final.foreign, foreign);
      });
    }
    it('refuses row and byte bounds and rolls back persistence failure while retaining good state', async function () {
      await lab.writeCanonical({ planned: { op: 'create', docs: [reading('bound-a', 111, 7)] } });
      await lab.provisionView();
      let rows = 10000, bytes = 4 * 1024 * 1024, failPersistence = false, staged;
      const observed = { ...lab.reader, async query (text, values) {
        const result = await lab.reader.query(text, values);
        if (failPersistence && text.startsWith('UPDATE')) {
          staged = { result, externallyVisibleCheckpoint: await lab.checkpointView(lab.A) };
          throw new Error('M5_SYNTHETIC_PERSISTENCE_FAILURE');
        }
        return result;
      } };
      const actual = lab.consumer('clinical-view', observed);
      const replay = { reconcile: () => actual.reconcile({ maxRows: rows, maxBytes: bytes }) };
      const instance = lab.evaluator(lab.A, { replay });
      await lab.at(at, async () => {
        const good = await instance.evaluate({ at }), saved = await lab.checkpointView(lab.A);
        await lab.writeCanonical({ planned: { op: 'create', docs: [reading('bound-b', 222, 2)] } });
        const physical = await lab.physical();
        const foreign = await lab.physical(lab.B);
        for (const scenario of ['row', 'byte', 'persistence']) {
          rows = scenario === 'row' ? 1 : 10000;
          bytes = scenario === 'byte' ? 1 : 4 * 1024 * 1024;
          failPersistence = scenario === 'persistence';
          let error = null;
          try { await instance.evaluate({ at }); } catch (failure) { error = { name: failure.name, message: failure.message }; }
          const observation = lab.trace('snapshot-refusal-' + scenario, { scenario, error, staged,
            savedBefore: saved, physicalBefore: physical, physicalAfter: await lab.physical(),
            foreignBefore: foreign, foreignAfter: await lab.physical(lab.B), retained: instance.last() });
          assert.equal(observation.physicalAfter.tables.entries.length, 2, 'M5_SNAPSHOT_BOUND physical oversized inputs reached');
          assert.deepEqual(observation.physicalAfter.checkpoint, saved, 'M5_SNAPSHOT_BOUND_PERSISTENCE last good persisted projection retained');
          assert.equal(instance.last(), good, 'M5_SNAPSHOT_BOUND retained clinical state');
          assert.deepEqual(observation.physicalAfter.tables, physical.tables);
          assert.deepEqual(observation.foreignAfter, foreign);
          assert.equal(error && error.name, 'Error', 'M5_SNAPSHOT_REFUSAL wrong failure layer');
          assert.equal(error.message, scenario === 'persistence' ? 'M5_SYNTHETIC_PERSISTENCE_FAILURE'
            : scenario === 'row' ? 'REPLAY_SNAPSHOT_ROW_BOUND' : 'REPLAY_SNAPSHOT_BYTE_BOUND');
          if (scenario === 'persistence') {
            assert.equal(staged.result.rowCount, 1, 'M5_SNAPSHOT_ROLLBACK actual checkpoint UPDATE reached');
            assert.deepEqual(staged.externallyVisibleCheckpoint, saved, 'M5_SNAPSHOT_ROLLBACK uncommitted replacement invisible');
          }
        }
        rows = 10000; bytes = 4 * 1024 * 1024; failPersistence = false;
        const retry = await instance.evaluate({ at });
        const restored = lab.trace('snapshot-refusal-restored', { retry, observation: await lab.compare(at) });
        assert.equal(instance.last(), retry);
        parity(restored.observation, 'M5_SNAPSHOT_REFUSAL_RESTORED');
      });
      instance.close();
    });

    it('reads a complete consistent old cohort across paging and a concurrent canonical commit', async function () {
      const ids = ['snapshot-a', 'snapshot-b', 'snapshot-c', 'snapshot-d'];
      for (const [index, id] of ids.entries()) await lab.writeCanonical({ planned: { op: 'create', docs: [reading(id, 111 + index, 7 - index)] } });
      await lab.writeCanonical({ tenant: lab.B, planned: { op: 'create', docs: [reading(ids[0], 333, 2)] } });
      await lab.provisionView();
      const before = await lab.physical(), foreign = await lab.physical(lab.B);
      let writer, pages = 0;
      const observed = { ...lab.reader, async query (text, values) {
        const result = await lab.reader.query(text, values);
        if (text.startsWith('SELECT domain') && text.includes('snapshot_source') && result.rows.length) {
          pages++;
          if (pages === 1) writer = await lab.writeAtomicEntries(ids.map((id, index) => ({ id, value: 221 + index })));
        }
        return result;
      } };
      const recovered = await scope.withTenant(lab.A, () => lab.consumer('clinical-view', observed)
        .reconcile({ maxRows: 10000, maxBytes: 4 * 1024 * 1024 }));
      const after = await lab.physical(), foreignAfter = await lab.physical(lab.B);
      lab.trace('snapshot-interleaving', { before, foreign, writer, pages, recovered, after, foreignAfter });
      assert.ok(pages >= 2, 'M5_SNAPSHOT_INTERLEAVE actual multiple full-snapshot pages');
      assert.equal(writer.status, 'committed');
      assert.equal(writer.earlyEvents, 0);
      assert.equal(writer.events.length, ids.length);
      assert.ok(writer.events.every(event => event.stamp === writer.after.floor));
      assert.ok(after.floor > before.floor);
      assert.deepEqual(after.tables.entries.map(row => row.doc.sgv), [221, 222, 223, 224]);
      assert.deepEqual(recovered.rows.map(row => row.document), before.tables.entries.map(row => row.doc),
        'M5_SNAPSHOT_COHORT full old cohort, never a mixed old/new page');
      assert.equal(recovered.checkpoint, before.floor, 'M5_SNAPSHOT_COHORT floor and rows share snapshot');
      assert.equal(Number(after.checkpoint.checkpoint), before.floor);
      assert.deepEqual(after.checkpoint.projection.map(row => row.doc), before.tables.entries.map(row => row.doc));
      assert.deepEqual(foreignAfter, foreign);
      const fresh = lab.trace('snapshot-interleaving-next', await lab.compare(at));
      parity(fresh, 'M5_SNAPSHOT_INTERLEAVE_NEXT');
      assert.equal(fresh.clinical.checkpoint, after.floor);
    });
  });

optInSuite(process.env.NS_M5_CURRENT_STATE_PROOF_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_M5_CURRENT_STATE_PROOF_TEST=1 with disposable PostgreSQL')(
  'M5 evaluator preview lifecycle actual PostgreSQL', function () {
    this.timeout(60000);
    const lab = require('./fixtures/evaluator-preview-lab')();
    before(() => lab.open()); beforeEach(async () => { await lab.reset(); await lab.provisionPreview(); });
    afterEach(() => lab.stopChildren()); after(() => lab.close());
    const runtimeReading = (id, sgv, minutes) => { const instant = Date.now() - minutes * 60000;
      return { _id: id, type: 'sgv', sgv, date: instant, dateString: new Date(instant).toISOString(), direction: 'Flat' }; };
    const value = reply => reply && reply.result && reply.result.properties.bgnow?.mean;
    async function seed (tenant = lab.A, id = 'preview-reading', sgv = 111) {
      return lab.writeCanonical({ tenant, planned: { op: 'create', docs: [runtimeReading(id, sgv, 2)] } });
    }
    const cyclesOf = health => health.tenants.find(row => row.tenant === lab.A).cycles;
    async function start (config = lab.configure()) {
      const worker = await lab.worker(config);
      lab.tracePreview('preview-startup', { startup: worker.startup, physical: await lab.previewPhysical(), logs: worker.logs() });
      assert.equal(worker.startup.bootError, undefined, 'M5_EVAL_STARTUP privileged/schema/provisioning readiness');
      assert.deepEqual(worker.startup.contexts, ['evaluator'], 'M5_EVAL_LISTENERLESS_BOOT selected evaluator must start');
      assert.equal(worker.startup.servers, 0);
      return worker;
    }
    it('boots listenerless role and actual CLI and recovers current state on restart', async function () {
      const a = await seed(), b = await seed(lab.B, 'preview-reading', 333); committed(a); committed(b);
      const config = lab.configure(), worker = await start(config);
      const first = await worker.call('last'), physical = await lab.previewPhysical();
      lab.tracePreview('preview-first-result', { first, physical });
      assert.equal(value(first), 111); assert.equal(first.eligible, true);
      assert.equal(value(await worker.call('last', lab.B)), 333);
      const stopped = await lab.stopWorker(worker); assert.equal(stopped.code, 0);
      const removed = await lab.writeCanonical({ planned: { op: 'delete', target: { _id: 'preview-reading' } } });
      const activity = await lab.writeCanonical({ logical: 'activity', planned: { op: 'create', docs: [
        { _id: 'preview-activity', created_at: new Date().toISOString(), steps: 1 }
      ] } });
      committed(removed); committed(activity);
      const beforeRestart = await lab.previewPhysical();
      const cli = lab.cli(config);
      await lab.wait(async () => {
        if (cli.child.exitCode !== null || cli.child.signalCode !== null) throw new Error('Evaluator CLI exited before acquisition');
        const checkpoint = await lab.previewCheckpoint(lab.A);
        // Input projection COMMIT can precede the actual CLI startup log. Wait
        // for both before inspecting readiness or sending shutdown signals.
        return checkpoint.projection?.length === 1 && checkpoint.projection[0].domain === 'activity' &&
          /Evaluator preview started/.test(cli.logs().stdout);
      });
      const afterRestart = await lab.previewPhysical();
      lab.tracePreview('preview-cli-restart', { beforeRestart, afterRestart, logs: cli.logs(), removed, activity });
      assert.equal(afterRestart.A.tables.entries.length, 0);
      assert.equal(afterRestart.A.checkpoint.projection.length, 1);
      assert.equal(afterRestart.A.checkpoint.projection[0].doc.steps, 1);
      assert.equal(afterRestart.A.floor, beforeRestart.A.floor);
      assert.deepEqual(afterRestart.B, beforeRestart.B);
      assert.match(cli.logs().stdout, /Evaluator preview started/);
      const exit = new Promise(resolve => cli.child.once('exit', (code, signal) => resolve({ code, signal })));
      cli.child.kill('SIGTERM'); const result = await exit; assert.equal(result.code, 0); assert.equal(result.signal, null);
    });
    it('finds quiet canonical absence and unstamped activity through the explicit recovery backstop', async function () {
      await seed(); const config = lab.configure(d => { d.recoveryIntervalMs = 5; d.timeIntervalMs = 15; });
      const worker = await start(config), first = await worker.call('last');
      const removed = await lab.writeCanonical({ planned: { op: 'delete', target: { _id: 'preview-reading' } } });
      const activity = await lab.writeCanonical({ logical: 'activity', planned: { op: 'create', docs: [
        { _id: 'quiet-activity', created_at: new Date().toISOString(), steps: 2 }
      ] } });
      const afterWrites = await worker.call('last');
      // The output revision changes only with content (decision
      // evaluator-revision-on-content-change), and with work on change
      // (cost-proportional-to-activity) an unchanged tenant runs no cycles:
      // wait for the backstop's acquisition to converge the projection.
      await lab.wait(async () => {
        const checkpoint = await lab.previewCheckpoint(lab.A);
        // The projection COMMIT precedes the cycle's publication: wait for both.
        return checkpoint.projection?.length === 1 && checkpoint.projection[0].domain === 'activity' && checkpoint.projection[0].doc.steps === 2 &&
          (await worker.call('last'))?.outputRevision > first.outputRevision;
      });
      const observed = lab.tracePreview('preview-backstop', { first, afterWrites, last: await worker.call('last'),
        physical: await lab.previewPhysical(), removed, activity });
      committed(removed); committed(activity);
      assert.equal(observed.physical.A.tables.entries.length, 0);
      assert.equal(observed.physical.A.checkpoint.projection.length, 1, 'M5_EVAL_BACKSTOP_RECOVERY full current absence/activity converges without wake');
      assert.equal(observed.physical.A.checkpoint.projection[0].domain, 'activity', 'M5_EVAL_BACKSTOP_RECOVERY no stale deleted entry');
      assert.equal(observed.physical.A.checkpoint.projection[0].doc.steps, 2);
      assert.ok(observed.physical.A.floor > removed.before.floor, 'M5_EVAL_BACKSTOP the delete and activity advanced the floor');
      assert.ok(observed.last.outputRevision > first.outputRevision);
    });
    it('uses retained input for time-only ticks until explicit acquisition', async function () {
      await seed(); const worker = await start(), first = await worker.call('last');
      const written = await lab.writeCanonical({ planned: { op: 'create', docs: [runtimeReading('new-physical', 222, 1)] } });
      const cyclesBefore = cyclesOf(await worker.call('health'));
      const before = await lab.previewPhysical(), tick = await worker.call('tick'), after = await lab.previewPhysical();
      lab.tracePreview('preview-retained-time', { first, written, before, tick, after });
      committed(written); assert.equal(before.A.tables.entries.length, 2);
      assert.equal(value(tick), 111, 'M5_EVAL_TIME_RETAINED new physical row cannot leak through retained timer');
      assert.deepEqual(after.A.checkpoint, before.A.checkpoint, 'M5_EVAL_TIME_RETAINED no input checkpoint/projection advance');
      assert.equal(tick.inputCheckpoint, first.inputCheckpoint);
      // A time-only cycle ran on the retained input; its content is identical,
      // so it keeps the acquisition's output and revision.
      assert.ok(cyclesOf(await worker.call('health')) > cyclesBefore, 'M5_EVAL_TIME_RETAINED time-only cycle ran');
      assert.equal(tick.outputRevision, first.outputRevision, 'identical time-only content keeps its revision');
      const acquired = await worker.call('acquire'); lab.tracePreview('preview-time-acquired', { acquired, physical: await lab.previewPhysical() });
      // Both one-minute-apart readings enter the same shipping five-minute
      // bucket. Acquisition changes the mean; `last` remains the newest value.
      assert.equal(value(acquired), (111 + 222) / 2, 'M5_EVAL_ACQUIRED_BUCKET_MEAN');
      assert.equal(acquired.result.properties.bgnow.last, 222, 'M5_EVAL_ACQUIRED_NEWEST_LAST');
      assert.deepEqual(acquired.result.properties.bgnow.sgvs.map(row => [row._id, row.mgdl]).sort((a, b) => a[0].localeCompare(b[0])),
        [['new-physical', 222], ['preview-reading', 111]], 'M5_EVAL_ACQUIRED_EXACT_BUCKET_INPUT');
      assert.equal(acquired.inputCheckpoint, before.A.floor);
      assert.ok(acquired.inputCheckpoint > first.inputCheckpoint, 'M5_EVAL_ACQUIRED_INPUT_ADVANCED');
    });
    it('discards a reused-revision changed config and refuses stale cached eligibility', async function () {
      await seed(); const initial = lab.configure(), worker = await start(initial), first = await worker.call('last');
      const changed = lab.configure(d => { d.tenants[0].settings.enable = ['timeago']; });
      const tick = await worker.call('tick'), physical = await lab.previewPhysical();
      lab.tracePreview('preview-config-identity', { first, expectedIdentity: changed.identity(lab.A), tick, physical });
      assert.notEqual(changed.identity(lab.A), first.identity);
      assert.equal(tick, null, 'M5_EVAL_CONFIG_REBUILD changed content drops retained clinical frame even if revision reused');
      const acquired = await worker.call('acquire');
      assert.equal(acquired.identity, changed.identity(lab.A)); assert.equal(acquired.eligible, true);
      assert.equal(await worker.call('current', lab.A, { identity: first.identity }), false);
      assert.equal((await worker.call('last')).identity, acquired.identity);
      const disabled = lab.configure(d => { d.tenants.shift(); });
      const current = await worker.call('current', lab.A, { identity: acquired.identity });
      lab.tracePreview('preview-config-disabled', { disabledTenants: disabled.document.tenants.length, current,
        last: await worker.call('last'), physical: await lab.previewPhysical() });
      assert.equal(current, false); assert.equal(await worker.call('last'), null);
    });
    it('keeps tenant B progressing while A row or byte refusal retains last good output', async function () {
      for (const scenario of ['row', 'byte']) {
        if (scenario === 'byte') { await lab.reset(); await lab.provisionPreview(); }
        await seed(); await seed(lab.B, 'preview-reading', 333);
        const config = lab.configure(d => { if (scenario === 'row') { d.maxRows = 1; d.pageSize = 1; } else d.maxBytes = 10000; });
        const worker = await start(config), first = await worker.call('last'), checkpoint = await lab.previewCheckpoint(lab.A);
        const written = await lab.writeCanonical({ planned: { op: 'create', docs: [
          { ...runtimeReading('oversized-a', 222, 1), ...(scenario === 'byte' ? { extension: 'x'.repeat(11000) } : {}) }
        ] } });
        const refused = await worker.call('acquire'), b = await worker.call('acquire', lab.B), health = await worker.call('health');
        lab.tracePreview('preview-refusal-' + scenario, { written, first, refused, b, health, physical: await lab.previewPhysical(), checkpoint });
        assert.equal(refused.outputRevision, first.outputRevision, 'M5_EVAL_REFUSAL retains successful output revision');
        assert.equal(refused.eligible, false); assert.equal(value(refused), 111);
        assert.deepEqual(await lab.previewCheckpoint(lab.A), checkpoint, 'M5_EVAL_REFUSAL keeps good input');
        assert.equal(b.eligible, true); assert.equal(value(b), 333);
        await lab.stopWorker(worker);
      }
    });
    it('drains and fences a real in-flight clinical read before role shutdown', async function () {
      await seed(); const worker = await start(), first = await worker.call('last');
      await lab.writeCanonical({ planned: { op: 'create', docs: [runtimeReading('pending-new', 222, 1)] } });
      await worker.call('arm'); const held = worker.held(), running = worker.call('acquire'); await held;
      let finished = false; const stopping = worker.call('close').then(() => { finished = true; });
      await new Promise(resolve => setImmediate(resolve));
      const physicalWhileHeld = await lab.previewPhysical();
      await worker.call('release'); await Promise.all([running, stopping]);
      const last = await worker.call('last'), health = await worker.call('health');
      lab.tracePreview('preview-close-fence', { first, physicalWhileHeld, last, health, finished, physicalAfter: await lab.previewPhysical() });
      assert.equal(physicalWhileHeld.A.tables.entries.length, 2);
      assert.equal(health.closed, true); assert.equal(finished, true);
      assert.equal(last.outputRevision, first.outputRevision, 'M5_EVAL_CLOSE_FENCE no late output after shutdown starts');
      assert.equal(last.eligible, false); assert.equal(value(last), 111);
      await lab.stopWorker(worker);
    });
    it('refuses actual unsafe clinical clock checkpoint and unrelated grants before starting jobs', async function () {
      const grants = [[lab.namespaces.entries + '.entries', 'doc', 'UPDATE'],
        [lab.namespaces.clock + '.tenant_write_clock', 'last_stamp', 'UPDATE'],
        [lab.replayNamespace + '.tenant_consumer_checkpoint', 'tenant_id', 'UPDATE'],
        [lab.namespaces.settings + '.settings', null, 'SELECT']];
      for (const [table, column, privilege] of grants) {
        const quoted = table.split('.').map(n => '"' + n + '"').join('.');
        const action = column ? privilege + '(' + column + ')' : privilege;
        if (!column) await lab.admin.query('GRANT USAGE ON SCHEMA "' + lab.namespaces.settings + '" TO "' + lab.previewRole + '"');
        await lab.admin.query('GRANT ' + action + ' ON ' + quoted + ' TO "' + lab.previewRole + '"');
        try {
          const allowed = (await lab.admin.query(column ? 'SELECT has_column_privilege($1,$2,$3,$4) AS allowed'
            : 'SELECT has_table_privilege($1,$2,$3) AS allowed', column ? [lab.previewRole, table, column, privilege]
            : [lab.previewRole, table, privilege])).rows[0].allowed;
          const before = await lab.previewPhysical(), worker = await lab.worker(lab.configure());
          lab.tracePreview('preview-unsafe-grant', { table, column, privilege, allowed, startup: worker.startup,
            before, after: await lab.previewPhysical() });
          assert.equal(allowed, true, 'M5_EVAL_PRIVILEGE physical forbidden grant exists');
          assert.equal(worker.startup.bootError?.previewConfigError, true, 'M5_EVAL_PRIVILEGE actual PreviewConfigError class');
          assert.equal(worker.startup.bootError.message, 'evaluator preview readiness or initialization refused', 'M5_EVAL_PRIVILEGE bounded readiness refusal');
          assert.equal(worker.startup.ready, undefined);
          assert.deepEqual(await lab.previewPhysical(), before);
        } finally {
          await lab.admin.query('REVOKE ' + action + ' ON ' + quoted + ' FROM "' + lab.previewRole + '"');
          if (!column) await lab.admin.query('REVOKE USAGE ON SCHEMA "' + lab.namespaces.settings + '" FROM "' + lab.previewRole + '"');
        }
      }
    });
  });
