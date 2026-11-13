'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const { ObjectId } = require('mongodb');
const scope = require('../lib/storage/tenant-scope');
const createLab = require('./fixtures/tenant-projection-evaluator');
const projectionRead = require('../lib/storage/postgres-projection-read');
const { fromMongo } = require('../lib/storage/filter');
const { SCENARIOS } = require('./lib/views-equality/fixtures');
const { optInSuite } = require('./support/opt-in');

optInSuite(process.env.NS_TENANT_PROJECTION_EVALUATOR_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_TENANT_PROJECTION_EVALUATOR_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'dormant recovered tenant clinical projection actual PostgreSQL', function () {
    this.timeout(45000);
    const lab = createLab();
    const at = Date.UTC(2026, 10, 6, 12);
    before(() => lab.open());
    beforeEach(() => lab.reset());
    after(() => lab.close());
    const reading = (id, value, offset = 0) => ({ _id: id, type: 'sgv', sgv: value,
      date: at - 2 * 60000 + offset, dateString: new Date(at - 2 * 60000 + offset).toISOString(), direction: 'Flat' });
    async function seed () {
      const records = Object.values(SCENARIOS)[0](at);
      for (const [logical, docs] of Object.entries(records)) {
        records[logical] = docs.map((doc, i) => ({ ...doc, _id: logical + '-' + i }));
      }
      await lab.persistDomains(records);
    }
    it('rebuilds clinical properties equal to fresh physical reads after a new consumer handle', async function () {
      await seed(); await lab.provisionView();
      await lab.at(at, async () => {
        const first = await lab.evaluator().evaluate({ at });
        assert.deepEqual(first.properties, (await lab.fresh(lab.A, at)).properties);
        const saved = await lab.checkpointView(lab.A);
        const restarted = await lab.evaluator().evaluate({ at });
        assert.deepEqual(restarted.properties, first.properties);
        assert.equal(restarted.checkpoint, first.checkpoint);
        assert.deepEqual(await lab.checkpointView(lab.A), saved);
      });
    });
    it('preserves typed twins in SQL and the current clinical reading after replay', async function () {
      const id = '0123456789abcdef01234567';
      await lab.persistDomains({ entries: [reading(id, 111, -5 * 60000), reading(new ObjectId(id), 222)] });
      const replay = await lab.provisionView();
      const stored = await lab.typedRows();
      assert.equal(stored.length, 2, 'independent physical rows retain both twins before computation');
      assert.equal(new Set(stored.map(row => row.id_kind)).size, 2);
      await lab.at(at, async () => {
        const result = await lab.evaluator(lab.A, { replay }).evaluate({ at });
        assert.equal(result.properties.bgnow.mean, 222, 'clinical newest reading survives typed replay');
        const recovered = await scope.withTenant(lab.A, () => replay.catchUp());
        const reader = projectionRead({ tenant: lab.A, connection: lab.reader, logical: 'entries',
          documents: recovered.rows.map(row => row.document), maxRows: 10, maxBytes: 10000, env: lab.env });
        const rows = await scope.withTenant(lab.A, () => reader.findFiltered(fromMongo({}),
          { v1: true, sort: { _id: -1 }, options: { normalize: false } }));
        assert.equal(rows.length, 2);
        assert.equal(new Set(rows.map(row => typeof row._id === 'string' ? 'string' : 'objectid')).size, 2);
        assert.deepEqual(result.properties, (await lab.fresh(lab.A, at)).properties);
      });
    });
    it('bootstraps an advanced empty projection into the same current clinical reading', async function () {
      const modified = await lab.persistDomains({ entries: [reading('one', 123)] });
      await lab.provisionView(lab.A, { checkpoint: modified });
      const stored = await lab.typedRows();
      assert.equal(stored.length, 1);
      assert.equal(stored[0].doc.sgv, 123, 'independent stored reading exists before empty-cache bootstrap');
      await lab.at(at, async () => {
        const result = await lab.evaluator().evaluate({ at });
        assert.equal(result.properties.bgnow.mean, 123, 'advanced empty cache must reconstruct clinical state');
        assert.deepEqual(result.properties, (await lab.fresh(lab.A, at)).properties);
      });
    });
    it('retains independent A/B clinical results and refuses a foreign retained-state read', async function () {
      await lab.persistDomains({ entries: [reading('same', 111)] }, lab.A);
      await lab.persistDomains({ entries: [reading('same', 222)] }, lab.B);
      await lab.provisionView(lab.A); await lab.provisionView(lab.B);
      await lab.at(at, async () => {
        const a = lab.evaluator(lab.A), b = lab.evaluator(lab.B);
        assert.equal((await a.evaluate({ at })).properties.bgnow.mean, 111);
        assert.equal((await b.evaluate({ at })).properties.bgnow.mean, 222);
        assert.equal(a.last().properties.bgnow.mean, 111);
        assert.throws(() => scope.withTenant(lab.B, () => a.last()), /tenant scope/);
        assert.deepEqual(a.last().properties, (await lab.fresh(lab.A, at)).properties);
      });
    });
    it('retains the prior successful result after read failure and retries from committed projection', async function () {
      await lab.persistDomains({ entries: [reading('one', 111)] }); await lab.provisionView();
      let fail = false;
      // Downstream of the projection COMMIT: the statistics read (the views'
      // reads are answered in process since evaluator cost lane A).
      const v = lab.evaluator(lab.A, { dbstats: async () => {
        if (fail) throw new Error('Synthetic projection read unavailable');
        return lab.stats();
      } });
      await lab.at(at, async () => {
        const first = await v.evaluate({ at });
        await lab.persistDomains({ entries: [reading('one', 222)] });
        fail = true;
        await assert.rejects(v.evaluate({ at }), /Synthetic projection read unavailable/);
        assert.equal(v.last(), first);
        const saved = await lab.checkpointView(lab.A);
        assert.ok(saved.projection.length > 0, 'projection is durably available after downstream failure');
        fail = false;
        const retry = await v.evaluate({ at });
        assert.equal(retry.properties.bgnow.mean, 222);
        assert.deepEqual(retry.properties, (await lab.fresh(lab.A, at)).properties);
      });
    });
    it('recomputes the same checkpoint at a later explicit instant without a new write', async function () {
      await lab.persistDomains({ entries: [reading('one', 123)] }); await lab.provisionView();
      const v = lab.evaluator();
      const first = await lab.at(at, () => v.evaluate({ at }));
      const laterAt = at + 20 * 60000;
      await lab.at(laterAt, async () => {
        const later = await v.evaluate({ at: laterAt });
        assert.equal(later.checkpoint, first.checkpoint);
        assert.equal(later.now, laterAt);
        assert.deepEqual(later.properties, (await lab.fresh(lab.A, laterAt)).properties);
      });
    });
    it('recovers clinical state after the actual producer dies after commit before publication', async function () {
      await lab.provisionView();
      const child = fork(path.join(__dirname, 'fixtures/tenant-durable-replay-producer.js'), [], {
        silent: true, env: { ...process.env, NS_REPLAY_WRITER_CONFIG: JSON.stringify(lab.childConfig) }
      });
      const publications = [];
      let stderr = '';
      child.on('message', message => publications.push(message));
      child.stderr.on('data', bytes => { stderr += bytes; });
      const stopped = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Producer commit/death boundary timed out')); }, 15000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
      });
      assert.equal(stopped.signal, 'SIGKILL', stderr);
      assert.deepEqual(publications, []);
      const rows = await lab.typedRows();
      assert.equal(rows.length, 1, 'independent storage shows commit before death');
      assert.equal(rows[0].doc.sgv, 123, 'independent storage retains the committed clinical value');
      assert.ok(Number.isSafeInteger(rows[0].doc.date), 'committed clinical timestamp is explicit');
      // The synthetic producer uses a fixed clinical date. Pin the clinical
      // replay near that independently stored reading, as in the other cases;
      // wall time would eventually age it out of the existing two-day window.
      const instant = rows[0].doc.date + 2 * 60000;
      await lab.at(instant, async () => {
        const recovered = await lab.evaluator().evaluate({ at: instant });
        assert.equal(recovered.properties.bgnow.mean, 123, 'committed clinical reading survives producer death');
        assert.deepEqual(recovered.properties, (await lab.fresh(lab.A, instant)).properties);
        assert.equal(recovered.checkpoint, await lab.floor(lab.A));
      });
      const aged = rows[0].doc.date + 2 * 24 * 60 * 60000 + 1;
      await lab.at(aged, async () => {
        const recovered = await lab.evaluator().evaluate({ at: aged });
        assert.equal(recovered.properties.bgnow.mean, undefined, 'recovery preserves the clinical age window');
        assert.deepEqual(recovered.properties, (await lab.fresh(lab.A, aged)).properties);
      });
      assert.deepEqual(await lab.typedRows(), rows, 'aging evaluation never changes committed storage');
      await lab.at(instant, async () => {
        assert.equal((await lab.evaluator().evaluate({ at: instant })).properties.bgnow.mean, 123,
          'fresh replay of the same committed reading restores the clinical oracle');
      });
    });
  });
