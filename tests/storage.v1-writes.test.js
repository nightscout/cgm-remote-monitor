'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const modify = require('../lib/api3/storage/mongoCollection/modify');
const MongoCollection = require('../lib/api3/storage/mongoCollection');
const MongoCachedCollection = require('../lib/api3/storage/mongoCachedCollection');
const reads = require('../lib/server/storage-reads');
const writes = require('../lib/server/storage-writes');
const normalizeDeleteStatus = require('../lib/api/shared/delete-status');
const { cmp } = require('../lib/storage/filter');

// API v1, authorization storage and the socket write through the storage
// interface (lib/server/storage-writes.js). These pin what each interface
// method hands the driver for them, and what comes back, so a write sends
// MongoDB what it sent before and its caller replies as before.

function driver (calls, results = { }) {
  const record = name => function (...args) {
    calls.push([name, ...args]);
    return Promise.resolve(results[name] || { acknowledged: true });
  };
  const col = { };
  for (const name of ['bulkWrite', 'insertOne', 'insertMany', 'deleteOne', 'deleteMany',
    'replaceOne', 'updateOne', 'updateMany']) col[name] = record(name);
  col.find = function (filter, options) {
    calls.push(['find', filter, options]);
    const cursor = { sort: () => cursor, skip: () => cursor, limit: () => cursor, project: () => cursor,
      toArray: () => Promise.resolve(results.docs || [ ]) };
    return cursor;
  };
  return col;
}

describe('storage interface writes for API v1 and the socket', function ( ) {

  describe('bulkUpsert', function ( ) {
    it('carries $setOnInsert, $unset and removals in order, filters verbatim in the v1 dialect', async function ( ) {
      const calls = [ ];
      const fallback = { created_at: { $eq: 'T' }, eventType: { $eq: 'Note' },
        syncIdentifier: { $in: [null, ''], $not: { $type: 'array' } } };
      await writes.bulk({ bulkUpsert: (ops, options) => modify.bulkUpsert(driver(calls), ops, options) }, [
        { updateOne: { filter: { sysTime: { $eq: 'S' }, type: { $eq: 'sgv' } },
          update: { $set: { sgv: 1 }, $setOnInsert: { srvCreated: 2 }, $unset: { isValid: '' } }, upsert: true } }
      ], { ordered: true });
      assert.deepEqual(calls[0][1], [{ updateOne: { filter: { sysTime: { $eq: 'S' }, type: { $eq: 'sgv' } },
        update: { $set: { sgv: 1 }, $setOnInsert: { srvCreated: 2 }, $unset: { isValid: '' } }, upsert: true } }]);
      assert.deepEqual(Object.keys(calls[0][1][0].updateOne.update), ['$set', '$setOnInsert', '$unset']);
      assert.deepEqual(calls[0][2], { ordered: true });

      calls.length = 0;
      await writes.bulk({ bulkUpsert: (ops, options) => modify.bulkUpsert(driver(calls), ops, options) }, [
        { replaceOne: { filter: fallback, replacement: { a: 1 }, upsert: true } },
        { deleteMany: { filter: { _id: { $in: ['x'] } } } },
        { replaceOne: { filter: { _id: { $eq: 'y' } }, replacement: { b: 1 }, upsert: true } }
      ], { ordered: true });
      assert.deepEqual(calls[0][1], [
        { replaceOne: { filter: fallback, replacement: { a: 1 }, upsert: true } },
        { deleteMany: { filter: { _id: { $in: ['x'] } } } },
        { replaceOne: { filter: { _id: { $eq: 'y' } }, replacement: { b: 1 }, upsert: true } }]);
    });

    it('refuses a batch it cannot carry rather than changing it', function ( ) {
      const storage = { bulkUpsert: () => assert.fail('reached storage') };
      for (const ops of [
        [{ replaceOne: { filter: { }, replacement: { }, upsert: true } }, { updateOne: { filter: { }, update: { $set: { } }, upsert: true } }],
        [{ replaceOne: { filter: { }, replacement: { } } }],
        [{ updateOne: { filter: { }, update: { $inc: { a: 1 } }, upsert: true } }],
        [{ insertOne: { document: { } } }]
      ]) assert.throws(() => writes.bulk(storage, ops), TypeError);
    });
  });

  describe('deleteMany', function ( ) {
    it('answers in the driver key order, so a v1 delete body keeps its order', async function ( ) {
      const calls = [ ];
      const r = await modify.deleteMany(driver(calls, { deleteMany: { acknowledged: true, deletedCount: 2 } }),
        reads.toFilter({ _id: { $in: ['a', 'b'] } }), { v1: true });
      assert.deepEqual(Object.keys(r), ['acknowledged', 'deletedCount', 'deleted']);
      assert.deepEqual(calls[0], ['deleteMany', { _id: { $in: ['a', 'b'] } }]);
      const body = normalizeDeleteStatus(r);
      assert.deepEqual(Object.keys(body), ['acknowledged', 'deletedCount', 'n']);
      assert.deepEqual(body, { acknowledged: true, deletedCount: 2, n: 2 });
    });

    it('removes at most one document with { one: true }', async function ( ) {
      const calls = [ ];
      await writes.remove({ deleteMany: (ast, opts) => modify.deleteMany(driver(calls, { deleteOne: { acknowledged: true, deletedCount: 1 } }), ast, opts) },
        { _id: 'custom' }, { one: true });
      assert.deepEqual(calls[0], ['deleteOne', { _id: 'custom' }]);
    });
  });

  describe('updateMany', function ( ) {
    it('passes the socket update through as built in the v1 dialect', async function ( ) {
      const calls = [ ];
      const storage = { updateMany: (ast, changes, opts) => modify.updateMany(driver(calls), ast, changes, opts) };
      await writes.update(storage, { _id: 'x' }, { $set: { } }, { one: true });
      await writes.update(storage, { _id: 'x' }, { $set: { srvModified: 1 }, $unset: { $odd: 1 } }, { one: false });
      assert.deepEqual(calls[0], ['updateOne', { _id: 'x' }, { $set: { } }]);
      assert.deepEqual(calls[1], ['updateMany', { _id: 'x' }, { $set: { srvModified: 1 }, $unset: { $odd: 1 } }]);
      assert.throws(() => writes.update(storage, { _id: 'x' }, { $inc: { a: 1 } }), /Only \$set and \$unset/);
    });

    it('still checks field names in the strict dialect', async function ( ) {
      await assert.rejects(modify.updateMany(driver([ ]), cmp('eq', '_id', 'x'), { unset: { $odd: 1 } }),
        /may not start with \$/);
    });
  });

  describe('replaceFiltered', function ( ) {
    it('upserts when asked and reports the upserted id', async function ( ) {
      const calls = [ ];
      const r = await writes.replace({ replaceFiltered: (ast, doc, opts) => modify.replaceFiltered(driver(calls, {
        replaceOne: { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: 'new' } }), ast, doc, opts) },
      { identifier: { $eq: 'i' } }, { a: 1 }, { upsert: true });
      assert.deepEqual(calls[0], ['replaceOne', { identifier: { $eq: 'i' } }, { a: 1 }, { upsert: true }]);
      assert.equal(r.upsertedCount, 1);
      assert.equal(r.upsertedId, 'new');
    });
  });

  describe('source labels', function ( ) {
    function storageFor (context) {
      const bus = new EventEmitter();
      const events = [ ];
      bus.on('storage-write-committed', event => events.push(event));
      const ctx = { bus, store: { collection: () => driver([ ], { insertMany: { insertedCount: 1 } }) } };
      return { events, storage: reads.collection(ctx, { }, 'physical', 'food', context) };
    }

    it('labels each write by the source the storage was acquired with', async function ( ) {
      for (const [context, source] of [[undefined, 'v1/internal'], [{ source: 'socket' }, 'socket'],
        [{ source: 'internal' }, 'internal'], [{ source: 'v3' }, 'v3']]) {
        const { events, storage } = storageFor(context);
        await storage.insertMany([{ a: 1 }]);
        assert.deepEqual(events.map(e => [e.collection, e.source, e.operation]), [['food', source, 'insertMany']]);
      }
    });

    it('keeps API v3 labelled v3 by default and refuses an unknown source', function ( ) {
      const ctx = { store: { collection: () => driver([ ]) } };
      assert.throws(() => new MongoCollection(ctx, { }, 'x', 'x', [ ], { source: 'v1' }), /Unknown storage write source/);
      assert.equal(MongoCollection.SOURCES.V3, 'v3');
    });
  });

  describe('cache wrapper', function ( ) {
    it('passes the interface methods through and reloads the cache after a write by filter', async function ( ) {
      const bus = new EventEmitter();
      const updates = [ ];
      bus.on('data-update', u => updates.push(u));
      const base = { };
      for (const name of ['findFiltered', 'count', 'insertMany', 'deleteMany', 'bulkUpsert', 'updateMany', 'replaceFiltered']) {
        base[name] = async () => name;
      }
      base.deleteMany = async () => { throw new Error('partial'); };
      const cached = new MongoCachedCollection({ bus, cache: { treatments: [ ] } }, { }, 'treatments', base);
      assert.equal(await cached.findFiltered(), 'findFiltered');
      assert.equal(await cached.count(), 'count');
      assert.equal(updates.length, 0);
      assert.equal(await cached.bulkUpsert([ ]), 'bulkUpsert');
      await assert.rejects(cached.deleteMany(), /partial/);
      assert.deepEqual(updates, [{ type: 'treatments', op: 'remove', changes: undefined },
        { type: 'treatments', op: 'remove', changes: undefined }]);
    });
  });
});
