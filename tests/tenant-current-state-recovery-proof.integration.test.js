'use strict';

// Passing characterization means the bounded current-row limitation is present,
// not that runtime recovery or any milestone is complete. No product fix here.
const assert = require('node:assert/strict');
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
  'M5 current-row recovery uncertainty characterization', function () {
    this.timeout(60000);
    const lab = createLab();
    before(() => lab.open());
    beforeEach(() => lab.reset());
    after(() => lab.close());

    it('characterizes canonical hard-delete absence through replay restart and later floor with a diagnostic bootstrap', async function () {
      const control = process.env.NS_M5_CURRENT_STATE_DIAGNOSTIC;
      if (control && (control !== 'skip-bootstrap' || process.env.NS_M5_CURRENT_STATE_ARCHIVE_CONTROL !== '1')) {
        throw new Error('M5 diagnostic control requires explicit archived skip-bootstrap selection');
      }
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
      assert.equal(deleted.after.floor, deleted.before.floor, 'M5_HARD_DELETE_HYPOTHESIS unchanged durable floor');
      assert.equal(deleted.events[0].event.stamp, null, 'M5_HARD_DELETE_HYPOTHESIS null event stamp');
      const stale = lab.trace('after-delete-catchup-new-handle', await lab.compare(at));
      assert.equal(stale.clinical.checkpoint, deleted.after.floor);
      const absentKey = JSON.stringify(['entries', 'objectid', newer]);
      assert.ok(stale.projectionKeys.includes(absentKey), 'M5_HARD_DELETE_HYPOTHESIS removed typed key remains projected');
      assert.equal(stale.projectionKeys.length, 2, 'M5_HARD_DELETE_HYPOTHESIS absent key remains in persisted projection');
      assert.equal(mean(stale.clinical), 222, 'M5_HARD_DELETE_HYPOTHESIS stale clinical output');
      assert.equal(mean(stale.fresh), 111, 'M5_HARD_DELETE independent current-table clinical oracle');
      assert.notDeepEqual(stale.clinical.properties, stale.fresh.properties);
      assert.deepEqual(stale.foreign, foreign, 'M5_TENANT foreign stored values/floor/checkpoint unchanged');
      const restarted = lab.trace('restart-with-no-new-floor', await lab.compare(at));
      assert.deepEqual(restarted.projectionKeys, stale.projectionKeys);
      assert.equal(mean(restarted.clinical), 222);
      assert.equal(mean(restarted.fresh), 111);

      const unrelated = await lab.writeCanonical({ source: 'v1/internal',
        planned: { op: 'create', docs: [reading('m5-unrelated-advance', 98, 30)] } });
      lab.trace('unrelated-canonical-stamped-write', { unrelated });
      committed(unrelated);
      assert.ok(unrelated.after.floor > deleted.after.floor, 'M5_ADVANCE actual unrelated floor advancement');
      const advanced = lab.trace('advanced-checkpoint-new-handle', await lab.compare(at));
      assert.equal(advanced.clinical.checkpoint, unrelated.after.floor);
      assert.equal(advanced.physical.tables.entries.length, 2);
      assert.ok(advanced.projectionKeys.includes(absentKey));
      assert.equal(advanced.projectionKeys.length, 3, 'M5_ADVANCE_HYPOTHESIS advanced checkpoint still retains absent key');
      assert.equal(mean(advanced.clinical), 222);
      assert.equal(mean(advanced.fresh), 111);
      assert.deepEqual(advanced.foreign, foreign);

      const reset = control ? { skipped: true, before: await lab.checkpointView(lab.A), after: await lab.checkpointView(lab.A) }
        : await lab.resetProjectionOnly();
      const diagnostic = lab.trace('diagnostic-full-bootstrap', { reset, observation: await lab.compare(at) });
      assert.ok(diagnostic.observation.physical.tables.entries.every(row => row.doc._id !== newer),
        'M5_DIAGNOSTIC independent absence must precede parity verdict');
      assert.equal(reset.after.checkpoint, advanced.physical.checkpoint.checkpoint, 'M5_DIAGNOSTIC advanced checkpoint retained');
      assert.deepEqual(diagnostic.observation.foreign, foreign);
      assert.deepEqual(diagnostic.observation.physical.tables, advanced.physical.tables,
        'M5_DIAGNOSTIC only scratch checkpoint projection changed; independent physical inputs retained');
      // skip-bootstrap must fail HERE for actual absence/projection mismatch,
      // not from SQL setup, a timeout, a TypeError or a prior wrong-layer failure.
      parity(diagnostic.observation, 'M5_ABSENCE_DIAGNOSTIC_RESTORED');
      assert.equal(mean(diagnostic.observation.clinical), 111);
      if (!control) {
        assert.equal(reset.affected, 1);
        assert.equal(reset.after.projection, null);
      }

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
      it('characterizes dates:none activity create/update replay refusal from ' + source, async function () {
        await lab.provisionView();
        await lab.catchUp(); // provisioned empty baseline, not an activity refusal
        const before = await lab.physical();
        const foreign = await lab.physical(lab.B);
        const doc = { _id: new ObjectId('1234567890abcdef12345678'),
          created_at: new Date(at).toISOString(), date: at, steps: 1 };
        const created = await lab.writeCanonical({ logical: 'activity', source, planned: { op: 'create', docs: [doc] } });
        const firstAttempt = await lab.replayAttempt();
        lab.trace('activity-created-' + source, { created, firstAttempt, physical: await lab.physical(), foreign: await lab.physical(lab.B) });
        committed(created);
        assert.equal(created.after.tables.activity.length, 1, 'M5_ACTIVITY physical create reached');
        assert.equal(created.after.floor, before.floor, 'M5_ACTIVITY_HYPOTHESIS no allocated clock date');
        assert.equal(created.events[0].event.stamp, null);
        assert.equal(Object.hasOwn(created.after.tables.activity[0].doc, 'srvModified'), false);
        assert.equal(firstAttempt.error && firstAttempt.error.name, 'Error', 'M5_ACTIVITY wrong failure layer is invalid');
        assert.equal(firstAttempt.error.message, 'REPLAY_UNSTAMPED_OR_UNFENCED_ROW', 'M5_ACTIVITY_HYPOTHESIS exact replay refusal');
        assert.deepEqual(await lab.checkpointView(lab.A), before.checkpoint, 'M5_ACTIVITY refused replay commits no checkpoint');
        const changed = source === 'socket'
          ? { op: 'update', form: 'merge', target: { _id: doc._id }, fields: { steps: 2 } }
          : { op: 'update', docs: [{ ...doc, steps: 2 }] };
        const updated = await lab.writeCanonical({ logical: 'activity', source, planned: changed });
        const secondAttempt = await lab.replayAttempt();
        const final = lab.trace('activity-updated-' + source, { updated, secondAttempt,
          physical: await lab.physical(), foreign: await lab.physical(lab.B) });
        committed(updated);
        assert.equal(final.physical.tables.activity.length, 1);
        assert.equal(final.physical.tables.activity[0].doc.steps, 2, 'M5_ACTIVITY independent physical update reached');
        assert.equal(final.physical.floor, before.floor);
        assert.equal(Object.hasOwn(final.physical.tables.activity[0].doc, 'srvModified'), false);
        assert.equal(updated.events[0].event.stamp, null);
        assert.equal(secondAttempt.error && secondAttempt.error.name, 'Error');
        assert.equal(secondAttempt.error.message, 'REPLAY_UNSTAMPED_OR_UNFENCED_ROW');
        assert.deepEqual(final.physical.checkpoint, before.checkpoint);
        assert.deepEqual(final.foreign, foreign);
      });
    }
  });
