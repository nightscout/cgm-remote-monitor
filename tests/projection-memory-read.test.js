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
  it('normalizes nested snapshots in UTF-8 length/byte order without retaining their values', function () {
    const keys = ['zz', 'a', 'é', '中', '😀', '￿', '\ud800', '\ud801', '�', '',
      '__proto__', 'constructor', 'toString', '01', '2', '10'];
    // Independent specification of the previous byte ordering, including
    // equal UTF-8 encodings and integer keys' JavaScript enumeration order.
    function expected (value) {
      if (Array.isArray(value)) return value.map(expected);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.keys(value).sort((a, b) =>
        Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .map(key => [key, expected(value[key])]));
    }
    const documents = Array.from({ length: keys.length }, (_, i) => {
      const rotated = keys.slice(i).concat(keys.slice(0, i));
      const child = Object.fromEntries(rotated.map((key, j) => [key, [null, j, { nested: i }]]));
      return Object.fromEntries(rotated.map(key => [key, child]));
    });
    const input = documents.map((doc, i) => ({ id_kind: 'string', doc, ordinal: i + 1 }));
    const original = JSON.stringify(input);
    const rows = memoryRead.rowsOf(input);
    assert.equal(JSON.stringify(rows), JSON.stringify(input.map(row => ({ ...row, doc: expected(row.doc) }))));
    assert.equal(JSON.stringify(input), original);
    assert(Object.isFrozen(rows));
    assert(Object.isFrozen(rows[0].doc));
    assert(Object.isFrozen(rows[0].doc.__proto__.__proto__));
    assert.equal(Object.getPrototypeOf(rows[0].doc), Object.prototype);
    documents[0].a.a[2].nested = 99;
    assert.equal(rows[0].doc.a.a[2].nested, 0);
    const next = memoryRead.rowsOf(input);
    assert.equal(next[0].doc.a.a[2].nested, 99);
    assert.equal(JSON.stringify(memoryRead.jsonbOrdered(documents)), JSON.stringify(expected(documents)));
    const manyKeys = Object.fromEntries(Array.from({ length: 600 }, (_, i) =>
      ['key-' + (600 - i) + (i % 2 ? 'é' : '😀'), { zz: i, a: null }]));
    assert.equal(JSON.stringify(memoryRead.jsonbOrdered(manyKeys)), JSON.stringify(expected(manyKeys)));
    assert.deepEqual(memoryRead.rowsOf([]), []);
  });

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

  it('projects nested arrays with typed ids and independent results', async function () {
    const hex = '0123456789abcdef01234567';
    const r = reader([{ _id: new ObjectId(hex), selected: [{ a: { n: 1 }, omit: 9 }, null, 3],
      hidden: { history: [1, 2, 3] } }, { _id: hex, selected: [{ a: { n: 2 } }] }]);
    const options = { projection: { 'selected.a': 1 }, options: { normalize: false } };
    const first = await r.findFiltered(null, options);
    assert.deepEqual(first, [
      { selected: [{ a: { n: 1 } }, null, 3], _id: new ObjectId(hex) },
      { selected: [{ a: { n: 2 } }], _id: hex }
    ]);
    first[0].selected[0].a.n = 99;
    first[0].selected.push({ a: { n: 100 } });
    assert.deepEqual(await r.findFiltered(null, options), [
      { selected: [{ a: { n: 1 } }, null, 3], _id: new ObjectId(hex) },
      { selected: [{ a: { n: 2 } }], _id: hex }
    ]);
    assert.equal(await r.count(fromMongo({ _id: new ObjectId(hex) })), 1);
  });

  it('does not traverse excluded subtrees when copying projected results', async function () {
    // A getter witnesses deep traversal without allocating a large history.
    // Actual retained JSON has data members; this synthetic observer must
    // remain unread when the entire subtree is excluded from the result.
    const hidden = Object.freeze({ get history () { throw new Error('excluded history traversed'); } });
    const rows = Object.freeze([Object.freeze({ id_kind: 'string', ordinal: 1,
      doc: Object.freeze({ _id: 'x', keep: Object.freeze({ n: 1 }), hidden }) })]);
    const r = memoryRead({ rows });
    assert.deepEqual(await r.findFiltered(null, { projection: { keep: 1 }, options: { normalize: false } }),
      [{ keep: { n: 1 }, _id: 'x' }]);
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
