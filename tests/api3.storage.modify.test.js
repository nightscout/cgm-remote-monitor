'use strict';

require('should');

const { ObjectId } = require('mongodb');
const modify = require('../lib/api3/storage/mongoCollection/modify');
const MongoCollection = require('../lib/api3/storage/mongoCollection');

describe('API3 mongoCollection promise-based helpers', function () {
  describe('modify helpers', function () {
    it('insertOne uses promise-based collection methods and keeps existing behavior', async function () {
      const doc = { _id: new ObjectId(), type: 'sgv' };
      const insertedId = doc._id.toString();
      const col = {
        insertOne: function (receivedDoc) {
          arguments.length.should.equal(1);
          receivedDoc.should.equal(doc);
          return Promise.resolve({ insertedId: receivedDoc._id });
        }
      };

      const identifier = await modify.insertOne(col, doc);

      identifier.should.equal(insertedId);
      doc.should.not.have.property('_id');
    });

    it('replaceOne uses promise-based upsert without a callback', async function () {
      const doc = { value: 42 };
      const col = {
        replaceOne: function (filter, receivedDoc, options) {
          arguments.length.should.equal(3);
          filter.should.eql({ $or: [{ identifier: 'record-1' }] });
          receivedDoc.should.equal(doc);
          options.should.eql({ upsert: true });
          return Promise.resolve({ matchedCount: 1 });
        }
      };

      const matchedCount = await modify.replaceOne(col, 'record-1', doc);

      matchedCount.should.equal(1);
    });

    it('update and delete helpers use promise-based collection methods', async function () {
      const col = {
        updateOne: function (filter, update) {
          arguments.length.should.equal(2);
          filter.should.eql({ $or: [{ identifier: 'record-2' }] });
          update.should.eql({ $set: { value: 84 } });
          return Promise.resolve({ modifiedCount: 1 });
        },
        deleteOne: function (filter) {
          arguments.length.should.equal(1);
          filter.should.eql({ $or: [{ identifier: 'record-2' }] });
          return Promise.resolve({ deletedCount: 1 });
        },
        deleteMany: function (filter) {
          arguments.length.should.equal(1);
          filter.should.eql({ $or: [{ kind: 'sgv' }, { kind: 'mbg' }] });
          return Promise.resolve({ deletedCount: 2 });
        }
      };

      const updated = await modify.updateOne(col, 'record-2', { value: 84 });
      const deletedOne = await modify.deleteOne(col, 'record-2');
      const deletedMany = await modify.deleteManyOr(col, [
        { field: 'kind', operator: 'eq', value: 'sgv' },
        { field: 'kind', operator: 'eq', value: 'mbg' }
      ]);

      updated.should.eql({ updated: 1 });
      deletedOne.should.eql({ deleted: 1 });
      deletedMany.should.eql({ deleted: 2 });
    });
  });

  describe('collection metadata helpers', function () {
    function createCursor (observed, docs) {
      return {
        sort: function (spec) {
          observed.sort = spec;
          return this;
        },
        limit: function (value) {
          observed.limit = value;
          return this;
        },
        project: function (projection) {
          observed.projection = projection;
          return this;
        },
        toArray: function () {
          observed.toArrayCalls = (observed.toArrayCalls || 0) + 1;
          return Promise.resolve(docs);
        }
      };
    }

    function createStorage (observed, docs) {
      const col = {
        find: function () {
          arguments.length.should.equal(0);
          observed.findCalls = (observed.findCalls || 0) + 1;
          return createCursor(observed, docs);
        }
      };

      const ctx = {
        store: {
          collection: function (name) {
            observed.collectionName = name;
            return col;
          },
          ensureIndexes: function (receivedCol, fields) {
            receivedCol.should.equal(col);
            observed.indexFields = fields;
          },
          db: {
            admin: function () {
              return {
                buildInfo: function () {
                  arguments.length.should.equal(0);
                  observed.buildInfoCalls = (observed.buildInfoCalls || 0) + 1;
                  return Promise.resolve({ version: '5.9.2' });
                }
              };
            }
          }
        }
      };

      return new MongoCollection(ctx, {}, 'entries');
    }

    it('version uses promise-based buildInfo', async function () {
      const observed = {};
      const storage = createStorage(observed, []);

      const version = await storage.version();

      observed.collectionName.should.equal('entries');
      observed.buildInfoCalls.should.equal(1);
      version.should.eql({ storage: 'mongodb', version: '5.9.2' });
    });

    it('getLastModified uses promise-based cursor methods', async function () {
      const observed = {};
      const storage = createStorage(observed, [{ srvModified: 1234 }]);

      const lastModified = await storage.getLastModified('srvModified');

      observed.findCalls.should.equal(1);
      observed.sort.should.eql({ srvModified: -1 });
      observed.limit.should.equal(1);
      observed.projection.should.eql({ srvModified: 1 });
      observed.toArrayCalls.should.equal(1);
      lastModified.should.eql({ srvModified: 1234 });
    });
  });
});
