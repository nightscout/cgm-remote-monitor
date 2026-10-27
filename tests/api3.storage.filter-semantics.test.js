'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const MongoCollection = require('../lib/api3/storage/mongoCollection');
const { and, or, cmp, fromMongo } = require('../lib/storage/filter');

// The storage interface methods against a live mongod, through the real
// write-step proxy. Two things are pinned here.
//
// 1. WHAT A FILTER SELECTS. The filter AST passes values through untouched,
//    so MongoDB's own comparison rules apply. A PostgreSQL adapter written
//    beside it (held for ST-PG) had to reproduce each of these rules by hand,
//    and each was measured against mongod first. They are pinned here so that
//    a later "normalisation" of values in the MongoDB adapter, or a second
//    backend, cannot change an answer silently.
//
// 2. THAT EVERY INTERFACE WRITE CROSSES THE PERSISTENCE BOUNDARY
//    (lib/storage/write-step.js): it announces storage-write-committed with the
//    logical collection name, and treatments' conditional validated update
//    refuses an invalid change made through updateMany.
//
// Skipped without a database, like tests/api-v1-operator-allowlist.test.js;
// CI has one.

const mongoUrl = process.env.CUSTOMCONNSTR_mongo;
(mongoUrl ? describe : describe.skip)('storage interface over a live mongod', function ( ) {
  this.timeout(15000);
  const physical = 'stfilter_' + randomUUID().replace(/-/g, '');
  let client, db, raw, bus, env, events;

  function storage (logical) {
    // indexedFields [] so this test does not build v3's indexes on a scratch
    // collection; the logical name is what the boundary's rules key on.
    return new MongoCollection({ store: { collection: name => db.collection(name), db }, bus }
      , env, physical, logical, []);
  }

  before(async function ( ) {
    const { MongoClient } = require('mongodb');
    client = new MongoClient(mongoUrl);
    await client.connect();
    db = client.db();
    raw = db.collection(physical);
  });

  beforeEach(async function ( ) {
    await raw.deleteMany({ });
    bus = new EventEmitter();
    events = [];
    bus.on('storage-write-committed', event => events.push(event));
    env = { writeValidation: 'off' };
  });

  after(async function ( ) {
    try { if (raw) await raw.drop(); } finally { if (client) await client.close(); }
  });

  describe('what a filter selects', function ( ) {

    beforeEach(async function ( ) {
      await raw.insertMany([
        { _id: 1, sgv: 100 }, { _id: 2 }, { _id: 3, sgv: null }, { _id: 4, sgv: '120' }
        , { _id: 5, sgv: { } }, { _id: 6, sgv: [1, 2] }, { _id: 7, sgv: 'Loop' }, { _id: 8, sgv: 2 }
      ]);
    });

    async function ids (ast) {
      const docs = await storage('entries').findFiltered(ast, { sort: { _id: 1 }, options: { normalize: false } });
      return docs.map(d => d._id);
    }

    it('never compares across a BSON type bracket', async function ( ) {
      // "120" is a string: it is not >= 100, and $ne 100 does match it.
      assert.deepEqual(await ids(cmp('gte', 'sgv', 100)), [1]);
      assert.deepEqual(await ids(cmp('gte', 'sgv', '100')), [4, 7]);
      assert.deepEqual(await ids(cmp('ne', 'sgv', 100)), [2, 3, 4, 5, 6, 7, 8]);
    });

    it('matches a missing field and a field of another type with $nin', async function ( ) {
      assert.deepEqual(await ids(cmp('nin', 'sgv', [100])), [2, 3, 4, 5, 6, 7, 8]);
      assert.deepEqual(await ids(cmp('nin', 'sgv', [])), [1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('treats a null operand as its own bracket', async function ( ) {
      // $eq/$lte/$gte null match null AND missing; $lt/$gt null match nothing.
      for (const op of ['eq', 'lte', 'gte']) assert.deepEqual(await ids(cmp(op, 'sgv', null)), [2, 3], op);
      for (const op of ['lt', 'gt']) assert.deepEqual(await ids(cmp(op, 'sgv', null)), [], op);
      assert.deepEqual(await ids(cmp('ne', 'sgv', null)), [1, 4, 5, 6, 7, 8]);
    });

    it('reads $exists as key presence, with the operand as mongod reads it', async function ( ) {
      assert.deepEqual(await ids(cmp('exists', 'sgv', false)), [2]);
      assert.deepEqual(await ids(cmp('exists', 'sgv', true)), [1, 3, 4, 5, 6, 7, 8]);
      // `$exists ''` follows MongoDB: presence.
      assert.deepEqual(await ids(fromMongo({ sgv: { $exists: '' } })), [1, 3, 4, 5, 6, 7, 8]);
    });

    it('matches only strings with a regex', async function ( ) {
      // 100, 2 and [1, 2] contain digits but are not strings.
      assert.deepEqual(await ids(cmp('re', 'sgv', '\\d')), [4]);
      assert.deepEqual(await ids(cmp('re', 'sgv', '^loop', 'i')), [7]);
    });

    it('answers $type and the fallback key\'s not-an-array', async function ( ) {
      assert.deepEqual(await ids(cmp('type', 'sgv', 'string')), [4, 7]);
      assert.deepEqual(await ids(cmp('type', 'sgv', 2)), [4, 7]);
      assert.deepEqual(await ids(cmp('nottype', 'sgv', 'array')), [1, 2, 3, 4, 5, 7, 8]);
      assert.deepEqual(await ids(and(cmp('in', 'sgv', [null, '']), cmp('nottype', 'sgv', 'array'))), [2, 3]);
    });

    it('matches an empty subdocument literally', async function ( ) {
      assert.deepEqual(await ids(fromMongo({ sgv: { } })), [5]);
    });

    it('counts with the same filter', async function ( ) {
      assert.equal(await storage('entries').count(or(cmp('eq', 'sgv', 100), cmp('exists', 'sgv', false))), 2);
      assert.equal(await storage('entries').count(and()), 8);
    });

    it('bounds a read with limit and skip', async function ( ) {
      const docs = await storage('entries').findFiltered(and(), { sort: { _id: 1 }, skip: 2, limit: 3
        , options: { normalize: false } });
      assert.deepEqual(docs.map(d => d._id), [3, 4, 5]);
    });
  });

  describe('every interface write crosses the persistence boundary', function ( ) {

    it('announces each write with the logical collection name', async function ( ) {
      const s = storage('entries');
      await s.insertMany([{ _id: 'a', sgv: 1 }, { _id: 'b', sgv: 2 }]);
      await s.updateMany(cmp('eq', '_id', 'a'), { set: { sgv: 3 } });
      await s.replaceFiltered(cmp('eq', '_id', 'b'), { sgv: 4 });
      await s.bulkUpsert([{ filter: cmp('eq', '_id', 'c'), doc: { sgv: 5 } }], { mode: 'merge' });
      await s.deleteMany(cmp('eq', '_id', 'a'));
      assert.deepEqual(events.map(e => [e.collection, e.source, e.operation]), [
        ['entries', 'v3', 'insertMany'], ['entries', 'v3', 'updateMany'], ['entries', 'v3', 'replaceOne']
        , ['entries', 'v3', 'bulkWrite'], ['entries', 'v3', 'deleteMany']
      ]);
      assert.deepEqual((await raw.find({ }).sort({ _id: 1 }).toArray()).map(d => [d._id, d.sgv])
        , [['b', 4], ['c', 5]]);
    });

    it('does not resurrect a vanished document through replaceFiltered', async function ( ) {
      const r = await storage('profile').replaceFiltered(cmp('eq', '_id', 'gone'), { name: 'Default' });
      assert.equal(r.matchedCount, 0);
      assert.equal(await raw.countDocuments({ }), 0);
      assert.deepEqual(events, []);
    });

    it('subjects a treatments updateMany to the conditional validated update', async function ( ) {
      // A Temporary Target whose bottom would rise above its top is refused in
      // reject mode. If updateMany reached the driver around the boundary, the
      // change would be stored.
      await raw.insertOne({ _id: 'tt', eventType: 'Temporary Target', created_at: '2026-10-26T00:00:00.000Z'
        , duration: 30, targetBottom: 100, targetTop: 140, units: 'mg/dl' });
      env.writeValidation = 'reject';
      await assert.rejects(storage('treatments').updateMany(cmp('eq', '_id', 'tt'), { set: { targetBottom: 200 } })
        , err => err.name === 'WriteValidationError' && err.status === 400);
      assert.equal((await raw.findOne({ _id: 'tt' })).targetBottom, 100);
      assert.deepEqual(events, []);

      // The same change with validation off is stored: the refusal above was
      // the boundary's rule, not an unrelated failure.
      env.writeValidation = 'off';
      await storage('treatments').updateMany(cmp('eq', '_id', 'tt'), { set: { targetBottom: 200 } });
      assert.equal((await raw.findOne({ _id: 'tt' })).targetBottom, 200);
    });
  });
});
