'use strict';

// lib/storage/projection-memory-read.js (evaluator cost lane, A): the
// in-process projection reads answer as postgres-filter.js and PostgreSQL do.
// Sorted reads are in a total order: the keys, then the insertion ordinal
// (nulls last), then the typed identity (decision view-reads-total-order).
// tests/projection-total-order.integration.test.js compares the SQL path.
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const memoryRead = require('../lib/storage/projection-memory-read');
const { fromMongo } = require('../lib/storage/filter');
const { encodeDocument } = require('../lib/storage/postgres-identity');

function reader (documents, ordinals) {
  const rows = memoryRead.rowsOf(JSON.parse(JSON.stringify(documents.map((doc, i) => ({ ...encodeDocument(doc), ordinal: ordinals ? ordinals[i] : null })))));
  return memoryRead({ rows, legacyPatterns: true });
}
const ids = docs => docs.map(d => typeof d._id === 'string' ? d._id : 'oid:' + d._id.toHexString());

describe('projection-memory-read: the SQL path\'s answers without SQL', function () {
  it('breaks ties on the insertion ordinal (nulls last), then the typed identity', async function () {
    const hex = '0123456789abcdef01234567';
    const docs = [{ _id: 'b', k: 1 }, { _id: 'a', k: 1 }, { _id: hex, k: 1 }, { _id: new ObjectId(hex), k: 1 }, { _id: 'c', k: 0 }, { _id: 'd', k: 1 }];
    const r = reader(docs, [5, 2, null, null, 9, 3]);
    assert.deepEqual(ids(await r.findFiltered(null, { sort: { k: 1 }, options: { normalize: false } })), ['c', 'a', 'd', 'b', 'oid:' + hex, hex]);
    assert.deepEqual(ids(await r.findFiltered(null, { sort: { k: -1 }, options: { normalize: false } })), ['a', 'd', 'b', 'oid:' + hex, hex, 'c'],
      'the tie-break stays ascending under a descending key');
    assert.deepEqual(ids(await r.findFiltered(null, { sort: { k: -1 }, limit: 2, options: { normalize: false } })), ['a', 'd']);
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
