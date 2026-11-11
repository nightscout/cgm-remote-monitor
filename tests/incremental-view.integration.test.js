'use strict';

// Decision incremental-refresh on actual PostgreSQL: the shared incremental
// view over the durable-replay lab (entries, the tenant write clock, a
// NOSUPERUSER reader). Synthetic rows only.
// covers: lib/storage/postgres-incremental-view.js
const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const createLab = require('./fixtures/tenant-durable-replay');
const incrementalView = require('../lib/storage/postgres-incremental-view');
const { optInSuite } = require('./support/opt-in');

optInSuite(process.env.NS_TENANT_DURABLE_REPLAY_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_TENANT_DURABLE_REPLAY_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'incremental current-state view (actual PostgreSQL)', function () {
    this.timeout(120000);
    const lab = createLab();
    before(() => lab.open());
    beforeEach(() => lab.reset());
    after(() => lab.close());
    async function viewFor (overrides = {}) {
      const replay = await lab.provision('realtime-view');
      const maxRows = overrides.maxRows || 20000;
      const view = incrementalView.create({ connection: lab.reader, domains: { entries: lab.table }, indexed: ['entries'],
        clockTable: lab.namespaces.clock + '.tenant_write_clock', pageSize: 500, maxRows,
        reconcile: () => lab.makeConsumer('realtime-view', lab.reader, { maxRows: 20000, pageSize: 500 }).reconcile({ maxRows: 20000, maxBytes: 100000000 }), ...overrides });
      void replay;
      return { view, refresh: () => scope.withTenant(lab.A, () => view.refresh()) };
    }
    const sgvs = result => result.rows.map(row => [row.document._id, row.document.sgv, row.document.isValid]).sort();
    it('IV_EDIT_DELETE: edits and soft deletes apply incrementally; an unchanged floor is a count only', async function () {
      const { view, refresh } = await viewFor();
      await lab.persist([{ _id: 'a', sgv: 100 }, { _id: 'b', sgv: 110 }, { _id: 'c', sgv: 120 }]);
      assert.equal((await refresh()).mode, 'full');
      await lab.persist([{ _id: 'b', sgv: 111 }]);
      let result = await refresh();
      assert.equal(result.mode, 'incremental'); assert.equal(result.changed, 1);
      assert.deepEqual(sgvs(result), [['a', 100, undefined], ['b', 111, undefined], ['c', 120, undefined]], 'IV_EDIT reflected');
      await lab.persist([{ _id: 'c', sgv: 120, isValid: false }]);
      result = await refresh();
      assert.equal(result.mode, 'incremental');
      assert.deepEqual(sgvs(result), [['a', 100, undefined], ['b', 111, undefined]], 'IV_SOFT_DELETE reflected');
      result = await refresh();
      assert.equal(result.mode, 'unchanged'); assert.equal(view.stats().full, 1);
    });
    it('IV_HARD_DELETE: a hard delete (no stamp) is found by the physical count and runs a full reconcile', async function () {
      const { view, refresh } = await viewFor();
      await lab.persist([{ _id: 'a', sgv: 100 }, { _id: 'b', sgv: 110 }]);
      await refresh();
      await lab.admin.query(`DELETE FROM "${lab.namespaces.entries}".entries WHERE tenant_id=$1 AND "_id"='a'`, [lab.A]);
      const result = await refresh();
      assert.deepEqual(sgvs(result), [['b', 110, undefined]], 'IV_HARD_DELETE reflected without any write');
      assert.equal(result.mode, 'full'); assert.equal(view.stats().absences, 1);
      await lab.persist([{ _id: 'd', sgv: 130 }]);
      await lab.admin.query(`DELETE FROM "${lab.namespaces.entries}".entries WHERE tenant_id=$1 AND "_id"='b'`, [lab.A]);
      assert.deepEqual(sgvs(await refresh()), [['d', 130, undefined]], 'IV_HARD_DELETE_WITH_WRITE a hard delete beside a write');
    });
    it('IV_GAP: more changed rows than the bound runs a full reconcile', async function () {
      const { view, refresh } = await viewFor({ maxRows: 5, pageSize: 2 });
      await lab.persist([{ _id: 'a', sgv: 100 }]);
      await refresh();
      await lab.persist(Array.from({ length: 4 }, (_, i) => ({ _id: 'g' + i, sgv: 140 + i })));
      for (let i = 0; i < 3; i++) await lab.persist([{ _id: 'h' + i, sgv: 150 + i }]);
      const result = await refresh();
      assert.equal(result.mode, 'full'); assert.equal(view.stats().gaps, 1);
    });
    it('IV_MISMATCH: a clock floor below the checkpoint (rewind, restore) runs a full reconcile', async function () {
      const { view, refresh } = await viewFor();
      await lab.persist([{ _id: 'a', sgv: 100 }]);
      await refresh();
      await lab.admin.query(`UPDATE "${lab.namespaces.clock}".tenant_write_clock SET last_stamp = 0 WHERE tenant_id=$1`, [lab.A]);
      const result = await scope.withTenant(lab.A, () => view.refresh()).catch(error => error);
      // The full reconcile then refuses the rewound clock exactly as before (REPLAY_CLOCK_REWOUND).
      assert.equal(view.stats().mismatches, 1);
      assert.match(String(result?.message || result?.mode), /REPLAY_CLOCK_REWOUND|full/);
    });
    it('IV_COST: an incremental refresh reads only changed rows, whatever the stored size', async function () {
      const lines = [];
      for (const stored of [100, 1000, 10000]) {
        await lab.reset();
        const { refresh } = await viewFor();
        for (let i = 0; i < stored; i += 1000) await lab.persist(Array.from({ length: Math.min(1000, stored - i) }, (_, j) => ({ _id: 'r' + (i + j), sgv: 100 + ((i + j) % 200), type: 'sgv', date: 1700000000000 + i + j })));
        let t0 = process.hrtime.bigint(); const cold = await refresh(); const fullMs = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.equal(cold.rows.length, stored);
        const samples = [];
        for (let k = 0; k < 5; k++) {
          await lab.persist([{ _id: 'new' + k, sgv: 99, type: 'sgv', date: 1800000000000 + k }]);
          t0 = process.hrtime.bigint(); const result = await refresh(); samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
          assert.equal(result.mode, 'incremental'); assert.equal(result.changed, 1);
        }
        samples.sort((a, b) => a - b);
        // After VACUUM (as autovacuum does) the physical count is an index-only scan.
        await lab.admin.query(`VACUUM "${lab.namespaces.entries}".entries`);
        const vacuumed = [];
        for (let k = 0; k < 5; k++) {
          await lab.persist([{ _id: 'post' + k, sgv: 98, type: 'sgv', date: 1900000000000 + k }]);
          t0 = process.hrtime.bigint(); await refresh(); vacuumed.push(Number(process.hrtime.bigint() - t0) / 1e6);
        }
        vacuumed.sort((a, b) => a - b);
        lines.push({ stored, fullMs: +fullMs.toFixed(1), incrementalMedianMs: +samples[2].toFixed(1), afterVacuumMedianMs: +vacuumed[2].toFixed(1) });
      }
      console.log('      IV_COST ' + JSON.stringify(lines));
    });
  });
