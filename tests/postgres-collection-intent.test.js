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

  it('does not turn unsupported regex predicates into empty or unfiltered reads', async function () {
    const { port, calls } = fixture();
    await assert.rejects(reads.findAll(port.storage, { dateString: /^[0-9]/ }), /unsupported/);
    assert.equal(calls.length, 0);
  });

  it('admits only code-owned logical names and source labels', function () {
    assert.throws(() => create({ logical: 'arbitrary', source: 'v3' }), /trusted logical/);
    assert.throws(() => create({ logical: 'entries', source: 'legacy' }), /trusted logical/);
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
