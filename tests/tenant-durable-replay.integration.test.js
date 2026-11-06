'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const { ObjectId } = require('mongodb');
const scope = require('../lib/storage/tenant-scope');
const createLab = require('./fixtures/tenant-durable-replay');
const { optInSuite } = require('./support/opt-in');

optInSuite(process.env.NS_TENANT_DURABLE_REPLAY_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_TENANT_DURABLE_REPLAY_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'dormant durable current-state replay actual PostgreSQL', function () {
    this.timeout(30000);
    const lab = createLab();
    before(() => lab.open());
    beforeEach(() => lab.reset());
    after(() => lab.close());
    const catchUp = handle => scope.withTenant(lab.A, () => handle.catchUp());

    it('recovers after an actual producer dies after COMMIT before intent publication', async function () {
      const consumer = await lab.provision();
      const child = fork(path.join(__dirname, 'fixtures/tenant-durable-replay-producer.js'), [], {
        silent: true, env: { ...process.env, NS_REPLAY_WRITER_CONFIG: JSON.stringify(lab.childConfig) }
      });
      let stderr = '';
      const publications = [];
      child.stderr.on('data', bytes => { stderr += bytes; });
      child.on('message', message => publications.push(message));
      const stopped = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Synthetic producer did not reach its expected commit/death boundary'));
        }, 15000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
      });
      assert.equal(stopped.signal, 'SIGKILL', stderr);
      assert.deepEqual(publications, []);
      const rows = await lab.typedRows();
      assert.equal(rows.length, 1, 'producer data must have committed before death');
      const result = await catchUp(consumer);
      assert.equal(result.rows.length, 1);
      createLab.assertDocuments(result.rows.map(row => row.document), rows);
      assert.equal(result.checkpoint, await lab.floor(lab.A));
    });

    it('recovers durable projection on a new handle and duplicate wake-up changes nothing', async function () {
      const consumer = await lab.provision();
      await lab.persist([{ _id: 'one', sgv: 111 }]);
      const first = await catchUp(consumer);
      const saved = await lab.checkpoint();
      const restarted = await catchUp(lab.makeConsumer());
      assert.equal(restarted.changed, false);
      assert.deepEqual(restarted.rows, first.rows);
      assert.deepEqual(await lab.checkpoint(), saved);
    });

    it('bootstraps an advanced empty cache and completes typed tied pages then soft deletes', async function () {
      const id = '0123456789abcdef01234567';
      const modified = await lab.persist([{ _id: id, sgv: 111 }, { _id: new ObjectId(id), sgv: 112 }]);
      const consumer = await lab.provision('evaluator', lab.A, null, modified);
      const result = await catchUp(consumer);
      assert.equal(result.rows.length, 2);
      assert.equal(result.bootstrapped, true);
      assert.equal(typeof result.rows[0].document._id.toHexString, 'function');
      await lab.persist([{ _id: id, sgv: 111, isValid: false }, { _id: new ObjectId(id), sgv: 112, isValid: false }]);
      const deleted = await catchUp(lab.makeConsumer());
      assert.deepEqual(deleted.rows, []);
      assert.equal(deleted.checkpoint, await lab.floor(lab.A));
    });

    it('holds one explicit snapshot across pages while a writer overwrites a not-yet-read row', async function () {
      await lab.persist([{ _id: 'a', sgv: 111 }, { _id: 'b', sgv: 112 }]);
      const floor = await lab.floor(lab.A);
      const base = await lab.provision();
      let overwritten = false;
      const observed = Object.assign({}, lab.reader, { async query (sql, values) {
        const result = await lab.reader.query(sql, values);
        if (!overwritten && sql.startsWith('SELECT domain')) {
          overwritten = true;
          await lab.persist([{ _id: 'b', sgv: 150 }]);
        }
        return result;
      } });
      const first = await catchUp(lab.makeConsumer('evaluator', observed));
      assert.equal(overwritten, true);
      assert.deepEqual(first.rows.map(row => row.document.sgv), [111, 112]);
      assert.equal(first.checkpoint, floor);
      const next = await catchUp(base);
      assert.deepEqual(next.rows.map(row => row.document.sgv), [111, 150]);
    });

    it('forces tenant RLS on checkpoints and grants bookkeeping without clinical writes', async function () {
      await lab.provision('evaluator', lab.A);
      await lab.provision('evaluator', lab.B);
      await scope.withTenant(lab.A, async () => {
        const foreign = await lab.reader.query(`SELECT checkpoint FROM "${lab.replayNamespace}".tenant_consumer_checkpoint WHERE tenant_id=$1`, [lab.B]);
        assert.equal(foreign.rows.length, 0);
        const changed = await lab.reader.query(`UPDATE "${lab.replayNamespace}".tenant_consumer_checkpoint SET checkpoint=1 WHERE tenant_id=$1`, [lab.B]);
        assert.equal(changed.rowCount, 0);
        await assert.rejects(lab.reader.query(`DELETE FROM "${lab.namespaces.entries}".entries`), error => error.code === '42501');
        await assert.rejects(lab.reader.query(`UPDATE "${lab.namespaces.clock}".tenant_write_clock SET last_stamp=last_stamp+1`), error => error.code === '42501');
      });
      const security = await lab.admin.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass`,
        [lab.replayNamespace + '.tenant_consumer_checkpoint']);
      assert.deepEqual(security.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
    });

    it('rolls back a processed projection and checkpoint together before returning output', async function () {
      await lab.provision(); await lab.persist([{ _id: 'one', sgv: 111 }]);
      const before = await lab.checkpoint();
      const aborted = Object.assign({}, lab.reader, { snapshotTransaction (fn) {
        return lab.reader.snapshotTransaction(async () => {
          await fn();
          throw new Error('synthetic consumer failure before COMMIT');
        });
      } });
      await assert.rejects(catchUp(lab.makeConsumer('evaluator', aborted)), /before COMMIT/);
      assert.deepEqual(await lab.checkpoint(), before);
      assert.equal((await catchUp(lab.makeConsumer())).rows.length, 1);
    });

    it('rebuilds an incompatible projection and refuses an incomplete bounded scan', async function () {
      await lab.persist([{ _id: 'a', sgv: 111 }, { _id: 'b', sgv: 112 }]);
      const consumer = await lab.provision('evaluator', lab.A, [{ stale: true }], await lab.floor(lab.A), '0'.repeat(64));
      const before = await lab.checkpoint();
      await assert.rejects(catchUp(lab.makeConsumer('evaluator', lab.reader, { maxRows: 1 })), /REPLAY_ROW_BOUND/);
      assert.deepEqual(await lab.checkpoint(), before);
      const result = await catchUp(consumer);
      assert.equal(result.rows.length, 2);
      assert.equal(result.bootstrapped, true);
    });
  });
