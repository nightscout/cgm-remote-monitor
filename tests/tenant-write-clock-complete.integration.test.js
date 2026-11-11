'use strict';

// covers: lib/storage/postgres-entries-write.js, lib/storage/postgres-write-clock.js, lib/server/srv-dates.js, migrations/candidates/postgres-write-clock-v1.json

// Decision write-clock-complete on actual PostgreSQL (the commit-clock port lab):
// every supported write that changes stored input advances tenant_write_clock in
// the same transaction, hard deletes and activity writes included, and a hard
// delete also advances last_delete_stamp. Stamp-only detection (read the clock,
// compare with what was seen) then sees a hard delete: the scenario the
// evaluator lane's control C2 and the realtime lane's RT_HARD_DELETE_STAMP_ONLY
// recorded as a gap. Synthetic data only.
const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const createV3 = require('../lib/storage/postgres-entries-intent');
const createLegacy = require('../lib/storage/postgres-collection-intent');
const createLab = require('./fixtures/tenant-commit-clock-port');
const { optInSuite } = require('./support/opt-in');

const reading = (identifier, sgv = 123) => ({ identifier, device: 'synthetic-clock', type: 'sgv', sgv, date: 1793923200000, utcOffset: 0 });

optInSuite(process.env.NS_TENANT_COMMIT_CLOCK_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_TENANT_COMMIT_CLOCK_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'tenant write clock is complete: hard deletes and activity writes (actual PostgreSQL)', function () {
    this.timeout(30000);
    const lab = createLab();
    before(() => lab.open());
    beforeEach(() => lab.reset());
    after(() => lab.close());
    const entries = (worker = 0) => createV3({ connection: lab.clocks[worker], table: lab.table });
    const activity = (worker = 0) => createLegacy({ connection: lab.clocks[worker], table: lab.namespaces.activity + '.activity', logical: 'activity', source: 'v1/internal' });
    const write = (port, intent, tenant = lab.A) => scope.withTenant(tenant, () => port.write(intent));
    async function clock (tenant = lab.A) {
      const row = (await lab.admin.query(`SELECT last_stamp::text, last_delete_stamp::text FROM "${lab.namespaces.clock}".tenant_write_clock WHERE tenant_id=$1`, [tenant])).rows[0];
      return { last: Number(row.last_stamp), deleted: Number(row.last_delete_stamp) };
    }
    async function stored (identifier) {
      return (await lab.admin.query(`SELECT doc FROM "${lab.namespaces.entries}".entries WHERE tenant_id=$1 AND doc->>'identifier'=$2`, [lab.A, identifier])).rows;
    }

    it('a hard delete advances last_stamp and last_delete_stamp together', async function () {
      await write(entries(), { op: 'create', docs: [reading('kept')] }); await write(entries(), { op: 'create', docs: [reading('deleted')] });
      const before = await clock();
      assert.equal(before.deleted, 0);
      await write(entries(), { op: 'delete', form: 'permanent', target: { identifier: 'deleted' } });
      assert.deepEqual(await stored('deleted'), []);
      const after = await clock();
      assert.ok(after.last > before.last, 'last_stamp advanced');
      assert.equal(after.deleted, after.last, 'last_delete_stamp is the delete\'s commit stamp');
      await write(entries(), { op: 'create', docs: [reading('later')] });
      const later = await clock();
      assert.ok(later.last > after.last); assert.equal(later.deleted, after.deleted, 'an ordinary write leaves last_delete_stamp');
    });

    it('a delete that removes nothing advances nothing', async function () {
      const before = await clock();
      await write(entries(), { op: 'delete', form: 'permanent', target: { identifier: 'absent' } });
      assert.deepEqual(await clock(), before);
    });

    it('an activity insert and an activity edit each advance last_stamp', async function () {
      const port = activity();
      let before = await clock();
      await write(port, { op: 'create', docs: [{ identifier: 'activity-1', created_at: '2026-11-11T00:00:00.000Z', type: 'activity', duration: 10 }] });
      let after = await clock();
      assert.ok(after.last > before.last, 'activity insert advanced the clock'); assert.equal(after.deleted, 0);
      before = after;
      const rows = await scope.withTenant(lab.A, () => port.storage.findFiltered(require('../lib/storage/filter').fromMongo({ identifier: 'activity-1' }), { sort: { _id: 1 }, limit: 2, options: { normalize: false } }));
      assert.equal(rows.length, 1);
      await scope.withTenant(lab.A, () => lab.clocks[0].transaction(() => port.storage.updateMany(require('../lib/storage/filter').fromMongo({ identifier: 'activity-1' }), { set: { duration: 20 } }, {})));
      after = await clock();
      assert.ok(after.last > before.last, 'activity edit advanced the clock');
    });

    it('a rolled-back hard delete advances nothing and deletes nothing', async function () {
      await write(entries(), { op: 'create', docs: [reading('survives')] });
      const before = await clock();
      const port = entries();
      await assert.rejects(scope.withTenant(lab.A, () => lab.clocks[0].transaction(async () => {
        await port.storage.deleteMany(require('../lib/storage/filter').fromMongo({ identifier: 'survives' }));
        throw new Error('synthetic rollback');
      })), /synthetic rollback/);
      assert.deepEqual(await clock(), before);
      assert.equal((await stored('survives')).length, 1);
    });

    it('concurrent writes and deletes keep the stamp monotonic per tenant', async function () {
      const seen = [];
      const watcher = setInterval(async () => { try { seen.push(await clock()); } catch { /* lab closing */ } }, 5);
      try {
        const work = [];
        for (let i = 0; i < 20; i++) {
          work.push(write(entries(i % 2), { op: 'create', docs: [reading('c-' + i)] }));
          if (i % 3 === 0) work.push(write(entries((i + 1) % 2), { op: 'delete', form: 'permanent', target: { identifier: 'c-' + (i - 3) } }));
          work.push(write(activity(i % 2), { op: 'create', docs: [{ identifier: 'a-' + i, created_at: '2026-11-11T00:00:00.000Z', type: 'activity', duration: i }] }));
        }
        await Promise.all(work);
      } finally { clearInterval(watcher); }
      seen.push(await clock());
      for (let i = 1; i < seen.length; i++) {
        assert.ok(seen[i].last >= seen[i - 1].last, 'last_stamp never moves back');
        assert.ok(seen[i].deleted >= seen[i - 1].deleted, 'last_delete_stamp never moves back');
        assert.ok(seen[i].deleted <= seen[i].last, 'last_delete_stamp never ahead of last_stamp');
      }
      assert.ok(seen.at(-1).deleted > 0, 'deletes recorded');
      assert.deepEqual(await clock(lab.B), { last: lab.initial, deleted: 0 }, 'the other tenant is untouched');
    });

    // The evaluator lane's C2 / realtime lane's RT_HARD_DELETE_STAMP_ONLY, with the
    // clock as the only detection input: a reader that remembers the stamps it saw
    // and reconciles fully when last_delete_stamp moved.
    it('stamp-only detection sees a hard delete and the deleted reading leaves the reconciled view', async function () {
      await write(entries(), { op: 'create', docs: [reading('r1', 110)] }); await write(entries(), { op: 'create', docs: [reading('r2', 120)] });
      const view = async () => (await lab.admin.query(`SELECT doc->>'identifier' AS id FROM "${lab.namespaces.entries}".entries WHERE tenant_id=$1 ORDER BY 1`, [lab.A])).rows.map(row => row.id);
      const seen = await clock(); let shown = await view();
      assert.deepEqual(shown, ['r1', 'r2']);
      await write(entries(), { op: 'delete', form: 'permanent', target: { identifier: 'r2' } });
      const now = await clock();
      assert.ok(now.last > seen.last, 'STAMP_ONLY: the hard delete is visible as a stamp change');
      assert.ok(now.deleted > seen.deleted, 'STAMP_ONLY: and as a delete, so the reader reconciles fully');
      if (now.deleted > seen.deleted) shown = await view();
      assert.deepEqual(shown, ['r1'], 'the deleted reading leaves the display');
    });
  });
