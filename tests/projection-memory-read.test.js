'use strict';

// lib/storage/projection-memory-read.js (evaluator cost lane, A): the
// in-process projection reads answer as postgres-filter.js and PostgreSQL do.
// The tie orders below were read from PostgreSQL 16.15 (ORDER BY one key over
// jsonb_to_recordset, rows i = 0..n-1 with key 1 when i % 3 == 0, else 2);
// tools/tenancy/eval-cost/sort-lab.cjs and read-lab.cjs in the alignment
// repository compare against a live server.
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const memoryRead = require('../lib/storage/projection-memory-read');
const { fromMongo } = require('../lib/storage/filter');
const { encodeDocument } = require('../lib/storage/postgres-identity');

const POSTGRES_TIES = {
  6: '000,003,001,002,004,005',
  7: '003,000,006,005,004,001,002',
  8: '003,006,000,004,005,007,001,002',
  12: '000,003,006,009,004,005,010,007,008,001,002,011',
  41: '027,009,003,030,021,015,033,006,024,036,012,018,039,000,020,022,023,025,026,028,029,031,032,034,035,037,038,040,001,002,004,005,007,008,010,011,013,014,016,017,019'
};

function reader (documents) {
  const rows = memoryRead.rowsOf(JSON.parse(JSON.stringify(documents.map(encodeDocument))));
  return memoryRead({ rows, legacyPatterns: true });
}
const ids = docs => docs.map(d => typeof d._id === 'string' ? d._id : 'oid:' + d._id.toHexString());

describe('projection-memory-read: the SQL path\'s answers without SQL', function () {
  it('puts rows that tie on every sort key in PostgreSQL\'s order (quicksort and bounded heap)', async function () {
    for (const [n, expected] of Object.entries(POSTGRES_TIES)) {
      const docs = Array.from({ length: Number(n) }, (_, i) => ({ _id: 'r' + String(i).padStart(3, '0'), k: i % 3 === 0 ? 1 : 2 }));
      const got = await reader(docs).findFiltered(null, { sort: { k: 1 }, options: { normalize: false } });
      assert.equal(got.map(d => d._id.slice(1)).join(','), expected, 'n=' + n);
      for (const limit of [1, 3]) {
        const bounded = await reader(docs).findFiltered(null, { sort: { k: 1 }, limit, options: { normalize: false } });
        // From PostgreSQL: up to twice the bound a quicksort, past it the heap.
        const expectedBounded = limit === 1 ? '000' : n === '6' ? '000,003,001' : '000,003,006';
        assert.equal(bounded.map(d => d._id.slice(1)).join(','), expectedBounded, 'n=' + n + ' limit=' + limit);
      }
    }
  });

  it('compares strings in byte (code point) order, numbers and booleans within their own type', async function () {
    const docs = [{ _id: 'a', v: '￿' }, { _id: 'b', v: '😀' }, { _id: 'c', v: 'B' }, { _id: 'd', v: 'a' }, { _id: 'e', v: 10 },
      { _id: 'f', v: 9 }, { _id: 'g', v: true }, { _id: 'h', v: false }, { _id: 'i', v: null }, { _id: 'j' }];
    const r = reader(docs);
    assert.deepEqual(ids(await r.findFiltered(null, { sort: { v: 1 }, options: { normalize: false } })),
      ['i', 'j', 'f', 'e', 'c', 'd', 'a', 'b', 'h', 'g'], 'null/missing, numbers, strings by code point (U+FFFF before U+1F600), booleans');
    assert.deepEqual(ids(await r.findFiltered(fromMongo({ v: { $gte: 'a' } }), { options: { normalize: false } })), ['a', 'b', 'd']);
    assert.deepEqual(ids(await r.findFiltered(fromMongo({ v: { $gt: 9 } }), { options: { normalize: false } })), ['e']);
    assert.deepEqual(ids(await r.findFiltered(fromMongo({ v: { $lte: null } }), { options: { normalize: false } })), ['i', 'j']);
    assert.deepEqual(ids(await r.findFiltered(fromMongo({ v: { $gt: null } }), { options: { normalize: false } })), []);
    assert.equal(await r.count(fromMongo({ v: { $exists: true } })), 9);
  });

  it('keeps the typed identity: an ObjectId _id and its same-spelling string are different rows', async function () {
    const hex = '0123456789abcdef01234567';
    const r = reader([{ _id: hex, v: 1 }, { _id: new ObjectId(hex), v: 2 }]);
    const byString = await r.findFiltered(fromMongo({ _id: hex }), { options: { normalize: false } });
    const byObjectId = await r.findFiltered(fromMongo({ _id: new ObjectId(hex) }), { options: { normalize: false } });
    assert.equal(byString.length, 1); assert.equal(byString[0].v, 1); assert.equal(typeof byString[0]._id, 'string');
    assert.equal(byObjectId.length, 1); assert.equal(byObjectId[0].v, 2); assert.equal(typeof byObjectId[0]._id.toHexString, 'function');
    assert.deepEqual(ids(await r.findFiltered(null, { sort: { _id: -1 }, options: { normalize: false } })), ['oid:' + hex, hex], 'ObjectId ranks after string');
  });

  it('returns documents as jsonb does: keys by length then bytes, its own copy each read', async function () {
    const r = reader([{ _id: 'x', zz: 1, a: { yy: 2, b: 3 }, mills: 5, ccc: [{ dd: 1, e: 2 }] }]);
    const [first] = await r.findFiltered(null, { options: { normalize: false } });
    assert.deepEqual(Object.keys(first), ['a', 'zz', '_id', 'ccc', 'mills']);
    assert.deepEqual(Object.keys(first.a), ['b', 'yy']);
    first.a.b = 99; first.ccc.push(1);
    const [second] = await r.findFiltered(null, { options: { normalize: false } });
    assert.equal(second.a.b, 3); assert.equal(second.ccc.length, 1);
  });

  it('matches arrays elementwise and legacy patterns with PostgreSQL\'s newline rule', async function () {
    const r = reader([{ _id: 'a', t: ['x', 'y'] }, { _id: 'b', t: 'y' }, { _id: 'c', s: 'ab\ncd' }, { _id: 'd', s: 'ab-cd' }, { _id: 'e', s: 'a😀b' }]);
    assert.deepEqual(ids(await r.findFiltered(fromMongo({ t: 'y' }), { options: { normalize: false } })), ['a', 'b']);
    assert.deepEqual(ids(await r.findFiltered(fromMongo({ t: { $ne: 'x' } }), { options: { normalize: false } })), ['b', 'c', 'd', 'e']);
    assert.deepEqual(ids(await r.findFiltered(fromMongo({ s: { $regex: '^ab.cd' } }), { v1: false, options: { normalize: false } })), ['d']);
    assert.deepEqual(ids(await r.findFiltered(fromMongo({ s: { $regex: 'a.b' } }), { options: { normalize: false } })), ['e'], "'.' is one character");
  });

  it('refuses exactly where the SQL path refuses', async function () {
    const r = reader([{ _id: 'a', k: [1, 2] }, { _id: 'b', k: 1 }]);
    await assert.rejects(r.findFiltered(null, { sort: { k: 1 } }), /sort over an array or subdocument value/);
    assert.deepEqual(ids(await r.findFiltered(fromMongo({ k: 1 }), { sort: { k: 1 }, skip: 5, limit: 1, options: { normalize: false } })), [],
      'no row returned, no refusal (the SQL window is read from a returned row)');
    await assert.rejects(r.findFiltered(null, { limit: 1 }), /without a sort/);
    await assert.rejects(r.findFiltered(fromMongo({ 'a.b': 1 })), /top-level fields only/);
    await assert.rejects(r.findFiltered(fromMongo({ k: { $regex: '[a-z]' } })), /literal\/time-helper subset/);
    await assert.rejects(r.findFiltered(null, { madeUp: true }), /find option/);
  });
});
