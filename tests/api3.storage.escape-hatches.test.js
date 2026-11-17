'use strict';

require('should');

const modify = require('../lib/api3/storage/mongoCollection/modify');
const find = require('../lib/api3/storage/mongoCollection/find');
const MongoCollection = require('../lib/api3/storage/mongoCollection');
const { and, or, cmp } = require('../lib/storage/filter');

// The storage interface methods API v1 and the socket need that API v3 did not
// expose (their callers: lib/server/storage-reads.js, storage-writes.js). These
// tests pin what each one hands the driver; tests/storage.v1-writes.test.js
// covers the API v1 dialect forms, and tests/api3.storage.filter-semantics.test.js
// runs them against a live mongod through the write-step boundary.

function fakeCol (observed, results) {
  return {
    bulkWrite: function (ops, options) {
      observed.bulkOps = ops;
      observed.bulkOptions = options;
      return Promise.resolve(results.bulk || {
        upsertedIds: { 0: 'newid' }, matchedCount: 1, modifiedCount: 1, upsertedCount: 1
      });
    },
    insertMany: function (docs, options) {
      observed.insertDocs = docs;
      observed.insertOptions = options;
      return Promise.resolve({ insertedCount: docs.length, insertedIds: { 0: 'a' } });
    },
    deleteMany: function (filter) {
      observed.deleteFilter = filter;
      // The driver always reports acknowledged; the double does too, so the
      // pass-through below is testing behaviour rather than a stub's omission.
      return Promise.resolve(Object.prototype.hasOwnProperty.call(results, 'del')
        ? results.del : { acknowledged: true, deletedCount: 3 });
    },
    replaceOne: function (filter, doc, options) {
      observed.replaceFilter = filter;
      observed.replaceDoc = doc;
      observed.replaceOptions = options;
      return Promise.resolve(results.replace ||
        { acknowledged: true, matchedCount: 1, modifiedCount: 1 });
    },
    updateMany: function (filter, update) {
      observed.updateFilter = filter;
      observed.update = update;
      return Promise.resolve({ acknowledged: true, matchedCount: 1, modifiedCount: 1 });
    },
    countDocuments: function (filter) {
      observed.countFilter = filter;
      return Promise.resolve(42);
    },
    find: function (filter, readOptions) {
      observed.findFilter = filter;
      observed.readOptions = readOptions;
      const cursor = {
        sort: function (v) { observed.sort = v; return cursor; },
        skip: function (v) { observed.skip = v; return cursor; },
        limit: function (v) { observed.limit = v; return cursor; },
        project: function (v) { observed.projection = v; return cursor; },
        toArray: function () { return Promise.resolve(results.docs || []); }
      };
      return cursor;
    }
  };
}

describe('storage interface escape hatches', function ( ) {

  describe('bulkUpsert', function ( ) {

    it('replaces wholesale by default', async function ( ) {
      // treatments, food and activity all use replaceOne semantics today.
      const observed = { };
      await modify.bulkUpsert(fakeCol(observed, { }),
        [{ filter: cmp('eq', 'identifier', 'x'), doc: { a: 1 } }]);

      observed.bulkOps.should.have.length(1);
      observed.bulkOps[0].should.have.property('replaceOne');
      observed.bulkOps[0].replaceOne.replacement.should.eql({ a: 1 });
      observed.bulkOps[0].replaceOne.upsert.should.equal(true);
      observed.bulkOps[0].replaceOne.filter.should.eql({ identifier: { $eq: 'x' } });
    });

    it('merges with $set in merge mode', async function ( ) {
      // entries uses updateOne + $set, so stored fields absent from the incoming
      // document survive. Defaulting this away would silently change behaviour.
      const observed = { };
      await modify.bulkUpsert(fakeCol(observed, { }),
        [{ filter: cmp('eq', 'identifier', 'x'), doc: { a: 1 } }], { mode: 'merge' });

      observed.bulkOps[0].should.have.property('updateOne');
      observed.bulkOps[0].updateOne.update.should.eql({ $set: { a: 1 } });
      observed.bulkOps[0].updateOne.upsert.should.equal(true);
    });

    it('refuses an unknown mode rather than falling back to replace', async function ( ) {
      // A misspelt 'merge' that replaced wholesale would destroy the stored
      // fields merge exists to keep.
      const observed = { };
      await modify.bulkUpsert(fakeCol(observed, { }),
        [{ filter: cmp('eq', 'i', 1), doc: { } }], { mode: 'Merge' })
        .should.be.rejectedWith(/mode must be 'replace' or 'merge'/);
      (observed.bulkOps === undefined).should.equal(true);
    });

    it('is ordered by default and can be unordered', async function ( ) {
      const a = { }, b = { };
      await modify.bulkUpsert(fakeCol(a, { }), [{ filter: cmp('eq', 'i', 1), doc: { } }]);
      a.bulkOptions.should.eql({ ordered: true });
      await modify.bulkUpsert(fakeCol(b, { }), [{ filter: cmp('eq', 'i', 1), doc: { } }], { ordered: false });
      b.bulkOptions.should.eql({ ordered: false });
    });

    it('returns upsertedIds so callers can assign _id back', async function ( ) {
      const result = await modify.bulkUpsert(fakeCol({ }, { }),
        [{ filter: cmp('eq', 'i', 1), doc: { } }]);
      result.upsertedIds.should.eql({ 0: 'newid' });
      result.should.have.properties(['matchedCount', 'modifiedCount', 'upsertedCount']);
    });

    it('does not call the driver for an empty batch', async function ( ) {
      const observed = { };
      const result = await modify.bulkUpsert(fakeCol(observed, { }), []);
      (observed.bulkOps === undefined).should.equal(true);
      result.upsertedIds.should.eql({ });
    });

    it('rejects a filter the AST cannot express', async function ( ) {
      await modify.bulkUpsert(fakeCol({ }, { }),
        [{ filter: { op: 'where', field: 'a', value: 1 }, doc: { } }])
        .should.be.rejectedWith(/unsupported operator/);
    });
  });

  describe('updateMany', function ( ) {

    it('applies set and unset together', async function ( ) {
      const observed = { };
      const r = await modify.updateMany(fakeCol(observed, { }), cmp('eq', '_id', 'x'),
        { set: { glucose: 100 }, unset: { notes: 1 } });
      observed.updateFilter.should.eql({ _id: { $eq: 'x' } });
      observed.update.should.eql({ $set: { glucose: 100 }, $unset: { notes: 1 } });
      r.should.eql({ matchedCount: 1, modifiedCount: 1, acknowledged: true });
    });

    it('omits the half that was not supplied', async function ( ) {
      const a = { }, b = { };
      await modify.updateMany(fakeCol(a, { }), cmp('eq', '_id', 'x'), { set: { g: 1 } });
      a.update.should.eql({ $set: { g: 1 } });
      await modify.updateMany(fakeCol(b, { }), cmp('eq', '_id', 'x'), { unset: { g: 1 } });
      b.update.should.eql({ $unset: { g: 1 } });
    });

    it('refuses a field name that would become an update operator', async function ( ) {
      // websocket.js passes client-supplied data straight into $set/$unset, so
      // a $-prefixed key is the path from "field name" to "update operator".
      for (const bad of [{ set: { $rename: { a: 'b' } } }, { unset: { $where: 1 } }]) {
        await modify.updateMany(fakeCol({ }, { }), cmp('eq', '_id', 'x'), bad)
          .should.be.rejectedWith(/may not start with \$/);
      }
    });

    it('refuses an empty or absent change set', async function ( ) {
      for (const bad of [{ }, { set: { } }, undefined, { set: null, unset: null }]) {
        await modify.updateMany(fakeCol({ }, { }), cmp('eq', '_id', 'x'), bad)
          .should.be.rejectedWith(/non-empty set or unset/);
      }
      await modify.updateMany(fakeCol({ }, { }), cmp('eq', '_id', 'x'), { set: [1, 2] })
        .should.be.rejectedWith(/must be an object/);
    });

    it('rejects a filter the AST cannot express', async function ( ) {
      await modify.updateMany(fakeCol({ }, { }), { op: 'where', field: 'a', value: 1 },
        { set: { a: 1 } }).should.be.rejectedWith(/unsupported operator/);
    });
  });

  describe('replaceFiltered', function ( ) {

    it('replaces in place and does NOT upsert', async function ( ) {
      // The distinction is the entire reason this method exists. The socket
      // path's profile dedup has already looked the document up; if it was
      // deleted in between, an upsert would resurrect a profile the user just
      // removed. So no options object is passed to the driver at all.
      const observed = { };
      const r = await modify.replaceFiltered(fakeCol(observed, { }),
        cmp('eq', '_id', 'x'), { name: 'Default' });
      observed.replaceFilter.should.eql({ _id: { $eq: 'x' } });
      observed.replaceDoc.should.eql({ name: 'Default' });
      (observed.replaceOptions === undefined).should.equal(true);
      r.should.eql({ matchedCount: 1, modifiedCount: 1, acknowledged: true });
    });

    it('reports matchedCount 0 when the document vanished', async function ( ) {
      // A caller must be able to tell "replaced" from "was already gone".
      const r = await modify.replaceFiltered(
        fakeCol({ }, { replace: { acknowledged: true, matchedCount: 0, modifiedCount: 0 } }),
        cmp('eq', '_id', 'gone'), { });
      r.matchedCount.should.equal(0);
    });

    it('rejects a filter the AST cannot express', async function ( ) {
      await modify.replaceFiltered(fakeCol({ }, { }),
        { op: 'where', field: 'a', value: 1 }, { })
        .should.be.rejectedWith(/unsupported operator/);
    });
  });

  describe('count', function ( ) {

    it('counts with a translated filter', async function ( ) {
      const observed = { };
      const n = await modify.count(fakeCol(observed, { }), and(cmp('gte', 'date', 1), cmp('lt', 'date', 9)));
      n.should.equal(42);
      // Compact conjunction, matching what the codebase already emits.
      observed.countFilter.should.eql({ date: { $gte: 1, $lt: 9 } });
    });
  });

  describe('deleteMany', function ( ) {

    it('deletes by a single filter expression', async function ( ) {
      const observed = { };
      const r = await modify.deleteMany(fakeCol(observed, { }), cmp('lt', 'date', 100));
      // Both spellings: `deleted` for deleteManyOr's contract, `deletedCount`
      // because API v1's delete endpoints put it on the wire.
      r.should.eql({ deleted: 3, deletedCount: 3, acknowledged: true });
      observed.deleteFilter.should.eql({ date: { $lt: 100 } });
    });

    it('reports what the driver said about acknowledgement, not `true`', async function ( ) {
      const r = await modify.deleteMany(
        fakeCol({ }, { del: { acknowledged: false, deletedCount: 0 } }), cmp('lt', 'date', 1));
      r.should.eql({ deleted: 0, deletedCount: 0, acknowledged: false });
    });

    it('refuses an empty or rather than deleting everything', async function ( ) {
      const observed = { };
      await modify.deleteMany(fakeCol(observed, { }), or())
        .should.be.rejectedWith(/or requires at least one node/);
      (observed.deleteFilter === undefined).should.equal(true);
    });
  });

  describe('insertMany', function ( ) {

    it('passes documents and options through', async function ( ) {
      const observed = { };
      const r = await modify.insertMany(fakeCol(observed, { }), [{ a: 1 }, { a: 2 }], { ordered: true });
      r.inserted.should.equal(2);
      observed.insertOptions.should.eql({ ordered: true });
    });
  });

  describe('findFiltered', function ( ) {

    it('applies cursor options as arguments, not as a chained cursor', async function ( ) {
      const observed = { };
      await find.findFiltered(fakeCol(observed, { docs: [] }),
        or(cmp('lt', 'sgv', 70), cmp('gt', 'sgv', 180)),
        { sort: { date: -1 }, limit: 10, skip: 5, projection: { sgv: 1 }, options: { normalize: false }
          , readOptions: { batchSize: 1000 } });

      observed.findFilter.should.eql({ $or: [{ sgv: { $lt: 70 } }, { sgv: { $gt: 180 } }] });
      observed.readOptions.should.eql({ batchSize: 1000 });
      observed.sort.should.eql({ date: -1 });
      observed.limit.should.equal(10);
      observed.skip.should.equal(5);
      observed.projection.should.eql({ sgv: 1 });
    });

    it('refuses a limit that does not parse instead of reading without one', async function ( ) {
      // MongoDB reads limit(0) as no limit, so defaulting an unparseable limit
      // to 0 would turn a bounded read into an unbounded one.
      const observed = { };
      await find.findFiltered(fakeCol(observed, { docs: [] }), null, { limit: 'all' })
        .should.be.rejectedWith(/limit must be an integer/);
      (observed.limit === undefined).should.equal(true);
      await find.findFiltered(fakeCol({ }, { docs: [] }), null, { skip: 'x' })
        .should.be.rejectedWith(/skip must be an integer/);
    });

    it('treats a null filter as unfiltered', async function ( ) {
      const observed = { };
      await find.findFiltered(fakeCol(observed, { docs: [] }), null, { });
      observed.findFilter.should.eql({ });
    });

    it('rejects a filter the AST cannot express', async function ( ) {
      await find.findFiltered(fakeCol({ }, { docs: [] }), { op: 'expr', field: 'a', value: 1 }, { })
        .should.be.rejectedWith(/unsupported operator/);
    });
  });

  describe('MongoCollection', function ( ) {

    function storeFor (observed) {
      return {
        collection: function ( ) { return fakeCol(observed, { }); },
        ensureIndexes: function (col, fields) { observed.indexed = fields; }
      };
    }

    it('keeps v3\'s index set as the default', function ( ) {
      const observed = { };
      new MongoCollection({ store: storeFor(observed) }, { }, 'entries');
      observed.indexed.should.eql(MongoCollection.indexedFields);
    });

    it('lets a v1 collection declare its own index set, or none', function ( ) {
      // A v1 module constructing this storage must not silently acquire v3's
      // identifier/srvModified/isValid indexes on its collection.
      const declared = { }, none = { };
      new MongoCollection({ store: storeFor(declared) }, { }, 'food', 'food', ['created_at']);
      declared.indexed.should.eql(['created_at']);
      new MongoCollection({ store: storeFor(none) }, { }, 'food', 'food', []);
      (none.indexed === undefined).should.equal(true);
    });

    it('exposes no driver handle', function ( ) {
      const storage = new MongoCollection({ store: storeFor({ }) }, { }, 'entries');
      (storage.col === undefined).should.equal(true);
      for (const name of ['findFiltered', 'count', 'insertMany', 'deleteMany', 'bulkUpsert'
        , 'updateMany', 'replaceFiltered']) {
        storage[name].should.be.a.Function();
      }
    });
  });
});
