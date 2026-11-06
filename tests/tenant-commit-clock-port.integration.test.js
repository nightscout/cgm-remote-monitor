'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const scope = require('../lib/storage/tenant-scope');
const createV3 = require('../lib/storage/postgres-entries-intent');
const createLegacy = require('../lib/storage/postgres-collection-intent');
const intent = require('../lib/storage/write-intent');
const dates = require('../lib/server/srv-dates');
const { fromMongo } = require('../lib/storage/filter');
const postgresDomains = require('../lib/server/serve/postgres-domains');
const createLab = require('./fixtures/tenant-commit-clock-port');
const { optInSuite } = require('./support/opt-in');

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const document = identifier => ({ identifier, device: 'synthetic-clock', type: 'sgv', sgv: 123,
  date: 1793923200000, utcOffset: 0 });

optInSuite(process.env.NS_TENANT_COMMIT_CLOCK_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_TENANT_COMMIT_CLOCK_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'tenant commit clock actual PostgreSQL port', function () {
    this.timeout(30000);
    const lab = createLab();
    before(() => lab.open());
    beforeEach(() => lab.reset());
    after(() => lab.close());
    const port = (worker, bus) => createV3({ connection: lab.clocks[worker], table: lab.table, bus });
    const write = (worker, identifier, tenant = lab.A) => scope.withTenant(tenant, () =>
      port(worker).write({ op: 'create', docs: [document(identifier)], canUpdate: true }));

    it('characterizes a durable uniqueness-only counter losing a lower late commit behind an observed higher cursor', async function () {
      const acquired = deferred(), release = deferred();
      // Authored alternative-design control, not a production mode: commit
      // the atomic counter before the data transaction. Real driver UPDATE
      // allocates the values; shipping step/adapter persist the documents.
      async function detached (worker, identifier, hold) {
        return scope.withTenant(lab.A, async () => {
          const allocated = await lab.raw[worker].query('UPDATE "' + lab.namespaces.clock +
            '".tenant_write_clock SET last_stamp=last_stamp+1 WHERE tenant_id=$1 RETURNING last_stamp', [lab.A]);
          const value = Number(allocated.rows[0].last_stamp);
          let issued = false;
          const allocator = { tenant: lab.A, active: true, next () {
            assert.equal(issued, false, 'The control admits one timestamped mutation');
            issued = true;
            return value;
          } };
          try {
            return await lab.raw[worker].transaction(() => dates.withAllocator(allocator, async () => {
              const step = intent.forCollectionResolved(port(worker).storage, 'entries', 'v3', { env: {} });
              await step.write({ op: 'create', docs: [document(identifier)] });
              if (hold) { acquired.resolve(); await release.promise; }
            }));
          } finally { allocator.active = false; }
        });
      }
      const first = detached(0, 'lower-late', true);
      first.catch(() => {});
      let cursor;
      try {
        await Promise.race([acquired.promise, first.then(() => { throw new Error('Held write ended before its barrier'); })]);
        await detached(1, 'higher-visible', false);
        const visible = await lab.rows();
        assert.deepEqual(visible.map(row => row.identifier), ['higher-visible']);
        cursor = visible[0].srvModified;
        assert.equal(cursor, lab.initial + 2);
      } finally {
        release.resolve();
        await Promise.allSettled([first]);
      }
      await first;
      const final = await lab.rows();
      assert.deepEqual(final.map(row => row.identifier), ['lower-late', 'higher-visible']);
      assert.equal(final[0].srvModified, lab.initial + 1);
      assert.deepEqual(await lab.rows(lab.A, cursor), [], 'Exclusive cursor misses the actual lower late commit');
    });

    it('holds lower allocation through COMMIT before an independent connection can expose a higher cursor', async function () {
      const acquired = deferred(), release = deferred();
      const bus = new EventEmitter();
      let events = 0;
      bus.on(intent.INTENT_EVENT, () => { events++; });
      const first = scope.withTenant(lab.A, () => lab.clocks[0].transaction(async () => {
        await port(0, bus).write({ op: 'create', docs: [document('lower-held')] });
        acquired.resolve();
        await release.promise;
      }));
      first.catch(() => {});
      let second;
      try {
        await Promise.race([acquired.promise, first.then(() => { throw new Error('Held write ended before its barrier'); })]);
        assert.deepEqual(await lab.rows(), [], 'Lower write must still be uncommitted');
        assert.equal(events, 0);
        assert.equal(await lab.floor(lab.A), lab.initial);
        second = write(1, 'higher-waiting');
        second.catch(() => {});
        await lab.waitForClockLock();
        assert.deepEqual(await lab.rows(), [], 'Higher cursor must not become visible ahead of held lower write');
        assert.equal(events, 0);
      } finally {
        release.resolve();
        await Promise.allSettled([first, second].filter(Boolean));
      }
      await first;
      await second;
      const rows = await lab.rows();
      assert.deepEqual(rows.map(row => row.identifier), ['lower-held', 'higher-waiting']);
      assert.deepEqual(rows.map(row => row.srvModified), [lab.initial + 1, lab.initial + 2]);
      assert.deepEqual((await lab.rows(lab.A, rows[0].srvModified)).map(row => row.identifier), ['higher-waiting']);
      assert.equal(events, 1);
      assert.equal(await lab.floor(lab.A), rows[1].srvModified);
    });

    it('rolls back actual data, high-water and queued logical events together', async function () {
      const bus = new EventEmitter();
      let events = 0;
      bus.on(intent.INTENT_EVENT, () => { events++; });
      await scope.withTenant(lab.A, () => assert.rejects(lab.clocks[0].transaction(async () => {
        await port(0, bus).write({ op: 'create', docs: [document('rolled-back')] });
        const visibleInside = await lab.raw[0].query('SELECT doc FROM "' + lab.namespaces.entries + '".entries');
        assert.equal(visibleInside.rows.length, 1);
        throw new Error('synthetic rollback after actual INSERT');
      }), /synthetic rollback after actual INSERT/));
      assert.deepEqual(await lab.rows(), []);
      assert.equal(await lab.floor(lab.A), lab.initial);
      assert.equal(events, 0);
      await write(1, 'after-rollback');
      assert.equal((await lab.rows())[0].srvModified, lab.initial + 1);
    });

    it('allows tenant B through the shared pool while tenant A holds and waits on its fence', async function () {
      const acquired = deferred(), release = deferred();
      const first = scope.withTenant(lab.A, () => lab.clocks[0].transaction(async () => {
        await port(0).write({ op: 'create', docs: [document('a-held')] });
        acquired.resolve();
        await release.promise;
      }));
      first.catch(() => {});
      let waiter;
      try {
        await Promise.race([acquired.promise, first.then(() => { throw new Error('Held write ended before its barrier'); })]);
        waiter = write(0, 'a-waiter');
        waiter.catch(() => {});
        await lab.waitForClockLock();
        await write(0, 'b-progress', lab.B);
        assert.deepEqual((await lab.rows(lab.B)).map(row => row.identifier), ['b-progress']);
        assert.deepEqual(await lab.rows(lab.A), []);
        assert.equal(await lab.floor(lab.A), lab.initial);
        assert.equal(await lab.floor(lab.B), lab.initial + 1);
      } finally {
        release.resolve();
        await Promise.allSettled([first, waiter].filter(Boolean));
      }
      await first;
      await waiter;
    });

    it('finalizes an earlier legacy plan above an intervening committed v3 cursor without changing its identities or domain dates', async function () {
      const step = createLegacy({ connection: lab.clocks[0], table: lab.table, logical: 'entries',
        source: 'v1/internal', env: {}, naturalOrder: true });
      await scope.withTenant(lab.A, async () => {
        // New identifiers still use the legacy time+type upsert key. Distinct
        // reading times admit two rows rather than an intentional re-send.
        const docs = [0, 1].map(i => ({ identifier: 'legacy-' + i, dateString: '2026-11-06T01:00:0' + i + '+01:00',
          type: 'sgv', sgv: 120 + i, nested: { falsy: false, zero: 0 } }));
        const planned = step.plan({ op: 'create', docs });
        const before = docs.map(doc => ({ ...doc }));
        const filters = planned.ops.map(op => structuredClone(op.updateOne.filter));
        assert.notDeepEqual(filters[0], filters[1], 'The fixture must admit two distinct legacy readings');
        await write(1, 'intervening-cursor');
        const cursor = (await lab.rows())[0].srvModified;
        await step.write(planned);
        const rows = await lab.rows(lab.A, cursor);
        assert.deepEqual(rows.map(row => row.identifier), ['legacy-0', 'legacy-1']);
        assert.deepEqual(rows.map(row => row.srvModified), [cursor + 1, cursor + 2]);
        rows.forEach((row, i) => {
          assert.equal(row.sysTime, before[i].sysTime);
          assert.equal(row.dateString, before[i].dateString);
          assert.equal(row.utcOffset, 60);
          assert.deepEqual(row.nested, before[i].nested);
          assert.equal(row.srvCreated, row.srvModified);
          assert.deepEqual(planned.ops[i].updateOne.filter, filters[i]);
          assert.equal(String(docs[i]._id), row._id);
        });
      });
    });

    it('refuses absent, stale and overprivileged provisioning without repairing state', async function () {
      const config = { writeClock: true, domains: ['entries'], namespaces: lab.namespaces,
        bindings: new Map([[lab.A, {}], [lab.B, {}]]) };
      await postgresDomains.assertServing(config, lab.raw[0]);
      await lab.admin.query('DELETE FROM "' + lab.namespaces.clock + '".tenant_write_clock WHERE tenant_id=$1', [lab.A]);
      await assert.rejects(postgresDomains.assertServing(config, lab.raw[0]), /missing or stale/);
      await assert.rejects(write(0, 'missing-floor'), /not provisioned/);
      assert.deepEqual(await lab.rows(), []);
      await lab.reset();
      await write(0, 'stored-ahead');
      await lab.admin.query('UPDATE "' + lab.namespaces.clock + '".tenant_write_clock SET last_stamp=0 WHERE tenant_id=$1', [lab.A]);
      await assert.rejects(postgresDomains.assertServing(config, lab.raw[0]), /missing or stale/);
      assert.equal(await lab.floor(lab.A), 0);
      await lab.reset();
      await lab.admin.query('GRANT UPDATE(tenant_id) ON "' + lab.namespaces.clock + '".tenant_write_clock TO "' + lab.role + '"');
      try { await assert.rejects(postgresDomains.assertServing(config, lab.raw[0]), /unsafe write clock privileges/); }
      finally { await lab.admin.query('REVOKE UPDATE(tenant_id) ON "' + lab.namespaces.clock + '".tenant_write_clock FROM "' + lab.role + '"'); }
      await postgresDomains.assertServing(config, lab.raw[0]);
    });

    it('preserves refusal to acquire a new commit boundary inside an unrelated raw transaction', async function () {
      await scope.withTenant(lab.A, () => lab.raw[0].transaction(() =>
        assert.rejects(lab.clocks[0].transaction(async () => {}), /commit boundary requires a new transaction/)));
      assert.equal(await lab.floor(lab.A), lab.initial);
      assert.deepEqual(await lab.rows(), []);
    });

    it('characterizes soft-delete ties of legacy identifier-absent typed twins across an exclusive history page boundary', async function () {
      // Preexisting typed twins are a seed, not concurrent raw-import coverage.
      // A truthy identifier would address each row by that identifier instead
      // of its legacy _id, so it would not exercise everyForm's twin selector.
      const hex = '1234567890abcdef12345678';
      for (const kind of ['objectid', 'string']) {
        const doc = { _id: hex, ...document('unused'), srvCreated: lab.initial, srvModified: lab.initial };
        delete doc.identifier;
        await lab.admin.query('INSERT INTO "' + lab.namespaces.entries +
          '".entries (tenant_id,id_kind,doc) VALUES ($1,$2,$3)', [lab.A, kind, doc]);
      }
      await scope.withTenant(lab.A, () => port(0).write({ op: 'delete', form: 'mark', target: { identifier: hex } }));
      const rows = await lab.rows();
      assert.equal(rows.length, 2);
      assert.ok(rows.every(row => row.isValid === false));
      assert.deepEqual(rows.map(row => row.srvModified), [lab.initial + 1, lab.initial + 1]);
      assert.equal(await lab.floor(lab.A), lab.initial + 1);
      const page = await scope.withTenant(lab.A, () => port(0).storage.findFiltered(
        fromMongo({ srvModified: { $gt: lab.initial } }),
        { sort: { srvModified: 1 }, limit: 1, options: { normalize: false } }));
      assert.equal(page.length, 1);
      assert.deepEqual(await lab.rows(lab.A, page[0].srvModified), [],
        'One allocation for these legacy twins omits the tied second row after an exclusive cursor');
    });
  });
