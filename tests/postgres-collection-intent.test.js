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
      const old = catalogues[logical];
      const next = selected.catalogues[logical];
      assert.deepEqual(next.migrations.slice(0, old.migrations.length), old.migrations);
      const validated = validateCatalogue(next);
      assert.equal(validated.length, old.migrations.length + 3);
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
});
