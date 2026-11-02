'use strict';

const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const { and, or, cmp, fromMongo } = require('../lib/storage/filter');
const { compileFilter, compileSort, Params } = require('../lib/storage/postgres-filter');
const entriesRead = require('../lib/storage/postgres-entries-read');

// The PostgreSQL read slice refuses what it does not reproduce BEFORE a query
// is sent. Answers it does give are compared with mongod in
// tests/postgres-entries-read.test.js.
describe('PostgreSQL entries read: refusals and parameterization', function () {
  const sent = [];
  const reader = entriesRead({ connection: { query: async (text, values) => { sent.push({ text, values }); return { rows: [] }; } } });
  const sorted = { sort: { _id: 1 } };

  beforeEach(function () { sent.length = 0; });

  async function refused (promise, pattern) {
    await assert.rejects(promise, error => error.unsupported === true && pattern.test(error.message));
    assert.deepEqual(sent, [], 'refused before querying');
  }

  it('refuses filter shapes whose MongoDB answer it does not reproduce', async function () {
    const cases = [
      [cmp('re', 'type', '^sg'), /operator 're'/],
      [cmp('eq', 'a.b', 1), /field path 'a\.b'/],
      [cmp('eq', 'date', new Date(0)), /operand type/],
      [cmp('eq', 'sgv', [1, 2]), /operand type/],
      [cmp('eq', 'sgv', {}), /operand type/],
      [cmp('in', 'sgv', [1, [2]]), /operand type/],
      [cmp('gt', 'sgv', NaN), /non-finite/],
      [cmp('eq', 'identifier', new ObjectId()), /ObjectId operand on 'identifier'/],
      [cmp('type', 'sgv', 'array'), /\$type "array"/],
      [cmp('type', 'sgv', 'int'), /\$type "int"/],
      [cmp('type', '_id', 'objectId'), /operator 'type' on _id/],
      [fromMongo({ type: 'sgv' }, { v1: true }), /API v1 dialect node/]
    ];
    for (const [ast, pattern] of cases) {
      await refused(reader.findFiltered(ast, sorted), pattern);
      await refused(reader.count(ast), pattern);
    }
  });

  it('refuses options, sorts and bounds it does not reproduce', async function () {
    const ast = cmp('eq', 'type', 'sgv');
    await refused(reader.findFiltered(ast, { v1: true }), /API v1 dialect/);
    await refused(reader.findFiltered(ast, { readOptions: { batchSize: 1000 } }), /readOptions/);
    await refused(reader.findFiltered(ast, { projection: { sgv: 1 } }), /projection/);
    await refused(reader.findFiltered(ast, { hint: 'x' }), /find option 'hint'/);
    await refused(reader.findFiltered(ast, { limit: 2 }), /without a sort/);
    await refused(reader.findFiltered(ast, { skip: 1 }), /without a sort/);
    await refused(reader.findFiltered(ast, { sort: { date: 1 }, limit: -1 }), /negative limit/);
    await refused(reader.findFiltered(ast, { sort: { date: 'asc' } }), /sort direction/);
    await refused(reader.findFiltered(ast, { sort: { 'a.b': 1 } }), /field path/);
    await refused(reader.findFiltered(ast, { sort: { a: 1, b: 1, c: 1, d: 1, e: 1 } }), /more than 4/);
    await refused(reader.findOne('abc', { sgv: 1 }), /projection/);
    await refused(reader.count(ast, { v1: true }), /API v1 dialect/);
    await assert.rejects(reader.findFiltered(ast, { sort: { date: 1 }, limit: 'x' }), /limit must be an integer/);
    await assert.rejects(reader.count(null), /filter node must be an object/);
    assert.deepEqual(sent, []);
  });

  it('binds every operand and field name rather than writing it into SQL', function () {
    const hostile = "x'); DROP TABLE entries; --";
    const params = new Params();
    const where = compileFilter(or(cmp('eq', 'type', hostile), and(cmp('exists', 'sgv', true),
      cmp('in', 'dateString', [hostile, 5])), cmp('eq', '_id', new ObjectId('1234567890abcdef12345678'))), params);
    const order = compileSort({ date: -1, _id: 1 }, params);
    for (const text of [where, order.orderBy, order.unsortable]) {
      assert.ok(!text.includes(hostile) && !/\b(type|sgv|dateString|date)\b/.test(text.replace(/jsonb_typeof/g, '')), text);
    }
    assert.ok(params.values.includes(hostile));
    assert.ok(params.values.includes('1234567890abcdef12345678'));
    assert.ok(['type', 'sgv', 'dateString', 'date'].every(field => params.values.includes(field)));
  });

  it('requires an explicit connection and a plain table name', function () {
    assert.throws(() => entriesRead({}), /tenant-bound connection/);
    const connection = { query () {} };
    for (const table of ['entries; drop', 'a.b.c', '"entries"', '', 'Entries']) {
      assert.throws(() => entriesRead({ connection, table }), /plain table name/);
    }
  });
});
