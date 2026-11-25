'use strict';

const assert = require('node:assert/strict');
const create = require('../lib/storage/postgres-collection-intent');
const reads = require('../lib/server/storage-reads');
const READ_OPTIONS = require('../lib/storage/mongo-read-options');

describe('trusted PostgreSQL collection translation', function () {
  function fixture () {
    const calls = [];
    const connection = {
      async query (sql, values) { calls.push({ sql, values }); return { rows: [] }; },
      async transaction (fn) { return fn(); }
    };
    return { calls, port: create({ connection, table: 'test.entries', logical: 'entries', source: 'v1/internal' }) };
  }

  it('translates legacy filters and the exact batch transport hint without changing sort or limit', async function () {
    const { port, calls } = fixture();
    await reads.list(port.storage, { type: 'sgv', date: { $gte: 123 } },
      { sort: { date: -1 }, count: 10, readOptions: READ_OPTIONS });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /ORDER BY/);
    assert.match(calls[0].sql, /LIMIT/);
    assert.ok(calls[0].values.includes('sgv'));
    assert.ok(calls[0].values.includes(123));
    assert.equal(calls[0].values.at(-1), 10);
  });

  it('breaks sorted treatment page ties on the selected catalogue ordinal', async function () {
    const treatments = require('../lib/server/tenant-app/treatments');
    const ordered = require('../lib/server/tenant-socket-order-port').catalogues.treatments;
    const plain = require('../migrations/candidates/postgres-treatments-v1.json');
    let statement;
    const connection = {
      async query (text) { statement = text; return { rows: [] }; },
      async transaction (fn) { return fn(); }
    };
    for (const catalogue of [ordered, plain]) {
      const v1 = treatments({ connection, catalogue, source: 'v1/internal', naturalOrder: catalogue === ordered }).storage;
      for (const direction of [-1, 1]) {
        await reads.list(v1, {}, { sort: { created_at: direction }, count: 10 });
        if (catalogue === plain) assert.doesNotMatch(statement, /insertion_ordinal/);
        else assert.match(statement, direction === -1 ? /, insertion_ordinal DESC LIMIT/ : /, insertion_ordinal ASC LIMIT/);
      }
      const v3 = treatments({ connection, catalogue }).storage;
      await v3.findMany({ filter: [], sort: { srvModified: 1 }, skip: 0, limit: 10 });
      if (catalogue === plain) assert.doesNotMatch(statement, /insertion_ordinal/);
      else assert.match(statement, /, insertion_ordinal ASC LIMIT/);
    }
  });

  it('keeps unsorted bounded reads and unsupported driver semantics refused', async function () {
    const { port, calls } = fixture();
    await assert.rejects(reads.find(port.storage, reads.toFilter({}), { limit: 1 }), /without a sort/);
    await assert.rejects(reads.find(port.storage, reads.toFilter({}), { readOptions: { batchSize: 1 } }), /driver read options/);
    assert.equal(calls.length, 0);
  });

  it('keeps optional socket order successor histories append-only and refuses unsupported domains', async function () {
    const selected = require('../lib/server/tenant-socket-order-port');
    const { validateCatalogue, INSERTION_NAMESPACE } = require('../lib/migrations/catalogue');
    const insertion = require('../lib/tenant-lifecycle/tenant-insertion-sql');
    const catalogues = { treatments: require('../migrations/candidates/postgres-treatments-v1.json'),
      devicestatus: require('../migrations/candidates/postgres-devicestatus-v1.json') };
    for (const logical of ['treatments', 'devicestatus']) {
      const latest = catalogues[logical].migrations.filter(m => m.name >= '0102_');
      assert.deepEqual(latest.map(m => m.name), ['0102_' + logical + '_created_at_arrays',
        ...(logical === 'treatments' ? ['0104_treatments_clinical_time'] : [])]);
      const tails = catalogues[logical].migrations.filter(m => m.name === '0098_'+logical+'_identifier_arrays' || m.name === '0099_'+logical+'_storage_bytes' || m.name === '0100_'+logical+'_storage_bytes_removed');
      assert.deepEqual(tails.map(m=>m.operation),[{kind:'identifier-array-index-v1',domain:logical},{kind:'clinical-storage-size-v1',domain:logical},{kind:'clinical-storage-size-removal-v1',domain:logical}]);
      const old = { migrations: catalogues[logical].migrations.filter(m => !tails.includes(m) && !latest.includes(m)) };
      const next = selected.catalogues[logical];
      assert.deepEqual(next.migrations.slice(0, old.migrations.length), old.migrations);
      // The socket-order successor alone drops the indexes its own 0002
      // and 0001 made redundant.
      const redundant = next.migrations.at(-1 - latest.length);
      assert.equal(redundant.name, '0101_' + logical + '_redundant_indexes');
      assert.deepEqual(redundant.up, logical === 'devicestatus' ? ['DROP INDEX devicestatus_tenant_created_at', 'DROP INDEX devicestatus_tenant_insertion'] : ['DROP INDEX treatments_tenant_insertion']);
      assert.deepEqual(next.migrations.slice(old.migrations.length + 3), [...tails, redundant, ...latest], 'shared index and size migrations are identical in both variants');
      const validated = validateCatalogue(next);
      assert.equal(validated.length, old.migrations.length + 3 + tails.length + 1 + latest.length);
      // The original socket ordering DDL stays at its immutable prefix position.
      const sql = validated[old.migrations.length].up;
      assert.match(sql[0], /CHECK \(false\) NOT VALID/);
      assert.match(sql[1], /VALIDATE CONSTRAINT socket_order_requires_empty/);
      assert.match(sql[3], /insertion_ordinal bigint GENERATED ALWAYS AS IDENTITY/);
      const conversion = validated[old.migrations.length + 1];
      assert.deepEqual(conversion.operation, { kind: 'tenant-insertion-v1', domain: logical });
      assert.deepEqual(conversion.up, insertion.build({ namespace: INSERTION_NAMESPACE, domain: logical }).up);
      const correction = validated[old.migrations.length + 2];
      assert.deepEqual(correction.operation, { kind: 'tenant-insertion-binding-v1', domain: logical });
      assert.deepEqual(correction.up, insertion.bindingCorrectionUp({ namespace: INSERTION_NAMESPACE, domain: logical }));
      assert.match(correction.up[0], /ERRCODE='42501'/);
    }
    await assert.rejects(selected({ logical: 'entries' }), /reviewed DATA domain/);
  });

  it('does not turn unsupported regex predicates into empty or unfiltered reads', async function () {
    const { port, calls } = fixture();
    await assert.rejects(reads.findAll(port.storage, { dateString: /^[0-9]/ }), /unsupported/);
    assert.equal(calls.length, 0);
  });

  it('admits only code-owned logical names and source labels', function () {
    assert.throws(() => create({ logical: 'arbitrary', source: 'v3' }), /trusted logical/);
    assert.throws(() => create({ logical: 'entries', source: 'legacy' }), /trusted logical/);
  });

  it('admits the literal socket source only with an owned commit boundary', async function () {
    assert.throws(() => create({ logical: 'treatments', source: 'socket', connection: {} }), /owned commit boundary/);
    const { EventEmitter } = require('node:events');
    const bus = new EventEmitter();
    const events = [];
    let committed = false;
    bus.on('storage-intent-committed', event => { assert.equal(committed, true); events.push(event); });
    const connection = { async query (sql) { return { rows: sql.includes('AS deleted')
      ? [{ deleted: '0', over_cap: false, unsortable: false }] : [] }; },
      async transaction (fn) { const value = await fn(); committed = true; return value; } };
    const port = create({ logical: 'treatments', source: 'socket', table: 'test.treatments', connection, bus });
    // A missing-record delete still crosses the owned boundary and emits its
    // socket intent only after it returns; actual persisted writes need the lab.
    await port.write({ op: 'delete', target: { _id: 'synthetic-absent' } });
    assert.equal(events.length, 1); assert.equal(events[0].source, 'socket');
  });

  it('canonicalizes only a derived UTC offset before JSON storage validation', function () {
    const Collection = require('../lib/api3/generic/collection');
    const app = { get: () => false, setENVTruthy: () => undefined };
    const collection = new Collection({
      app, ctx: {}, env: {}, colName: 'entries', storage: {}, intentFactory () {}
    });
    const derived = { date: '2026-11-03T00:00:00.123Z' };
    collection.parseDate(derived);
    assert.equal(Object.is(derived.utcOffset, -0), false);
    assert.equal(derived.utcOffset, 0);
    const supplied = { date: 1793664000123, utcOffset: -0 };
    collection.parseDate(supplied);
    assert.equal(Object.is(supplied.utcOffset, -0), true);
  });

  // R3 (plannable-scale, 2026-11-21): a v1 treatments batch's server-date read
  // (srv-dates findForReplace) and on-deleted read are one $or of a filter per
  // document. On PostgreSQL each statement cost time in proportion to its
  // filters and missed the api's 1 s deadline at 288 fallback-key treatments
  // under seed load. Synthetic values only.
  describe('a v1 batch read of many per-document filters', function () {
    const srvDates = require('../lib/server/srv-dates');
    const fallbackKey = require('../lib/server/treatment-fallback-key');
    const items = Array.from({ length: 70 }, (_, k) => {
      const doc = { eventType: k % 2 ? 'Temp Basal' : 'Meal Bolus', created_at: new Date(Date.UTC(2026, 10, 19) + k * 300000).toISOString(), rate: 1 };
      return { filter: fallbackKey.fallbackQuery(doc, doc.created_at, { withAmounts: true }), doc };
    });
    function treatments () {
      const calls = [];
      const connection = {
        async query (sql, values) { calls.push({ sql, values }); return { rows: [] }; },
        async transaction (fn) { return fn(); }
      };
      return { calls, port: create({ connection, table: 'test.treatments', logical: 'treatments', source: 'v1/internal' }) };
    }

    it('reads 32 filters per PostgreSQL statement; a reader without a bound (MongoDB) still reads 500', async function () {
      const { port, calls } = treatments();
      await srvDates.findForReplace(reads.documents(port.storage), items);
      assert.equal(calls.length, 3, 'ceil(70 / 32) statements');
      const mongoLike = [];
      await srvDates.findForReplace({ find: async query => { mongoLike.push(query); return []; }, findOne: async () => null }, items);
      assert.equal(mongoLike.length, 1);
      assert.equal(mongoLike[0].$or.length, 70);
    });

    it('bounds the $or once and plans no subquery per filter', async function () {
      const { port, calls } = treatments();
      await srvDates.findForReplace(reads.documents(port.storage), items.slice(0, 32));
      assert.equal(calls.length, 1);
      const sql = calls[0].sql;
      // One event-time lookup and one eventType bound for the whole $or, not one per branch.
      assert.equal((sql.match(/event_ms = ANY/g) || []).length, 1, 'one created_at bound');
      assert.equal(sql.match(/"eventType" = /g).length, 1, 'one eventType bound');
      assert.match(sql, /"eventType" = ANY\(/);
      // Array-element equality by containment: no correlated subquery to plan per leaf.
      assert.doesNotMatch(sql, /EXISTS/);
      assert.doesNotMatch(sql, /jsonb_array_elements/);
    });
  });
});
