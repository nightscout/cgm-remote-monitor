'use strict';

/**
 * cache-objectid-compat.test.js
 *
 * Regression test: MongoDB driver 5.x ObjectId has no enumerable properties,
 * so _.isEmpty(new ObjectId()) returns true.  This breaks cache.js
 * filterForAge() which uses `!_.isEmpty(object._id)` as the hasId check.
 *
 * On mongodb driver 3.x (v15.0.6), Object.keys(new ObjectID()) returned
 * ['_bsontype','id'], making _.isEmpty return false (correct).
 *
 * On mongodb driver 5.x / mongodb-legacy (dev), Object.keys(new ObjectId())
 * returns [], making _.isEmpty return true (incorrect – treats valid
 * ObjectId _id as empty).
 *
 * Affects: lib/server/cache.js filterForAge()
 * Affects: Any code path that puts ObjectId _id documents into the cache
 *   without first converting _id to a string via processRawDataForRuntime().
 *
 * Related: AAPS backfill display bug (entries in MongoDB but invisible on chart)
 */

const _ = require('lodash');
const { ObjectId } = require('mongodb-legacy');
const should = require('should');

describe('Cache ObjectId compatibility', function () {

  describe('_.isEmpty behavioral change with new ObjectId', function () {

    it('REGRESSION: _.isEmpty(ObjectId) returns true on driver 5.x', function () {
      const oid = new ObjectId();
      // This is the root cause: driver 5.x ObjectId has no enumerable keys
      Object.keys(oid).should.have.length(0);
      _.isEmpty(oid).should.equal(true);
      // But the ObjectId IS valid and non-null
      should.exist(oid);
      oid.toString().should.have.length(24);
    });

    it('_.isEmpty works correctly with string _id', function () {
      const stringId = new ObjectId().toString();
      _.isEmpty(stringId).should.equal(false);
    });

    it('processRawDataForRuntime converts ObjectId to string (mitigation)', function () {
      const ddata = require('../lib/data/ddata')();
      const doc = { _id: new ObjectId(), type: 'sgv', sgv: 120, date: Date.now() };
      const processed = ddata.processRawDataForRuntime([doc]);
      // After processing, _id should be a string
      (typeof processed[0]._id).should.equal('string');
      _.isEmpty(processed[0]._id).should.equal(false);
    });
  });

  describe('filterForAge hasId check', function () {

    // Reproduce the exact filterForAge logic from cache.js
    function filterForAge (data, ageLimit) {
      return _.filter(data, function (object) {
        var hasId = !_.isEmpty(object._id);
        var age = object.mills || object.date;
        var isFresh = typeof age === 'number' && age >= ageLimit;
        return isFresh && hasId;
      });
    }

    const TWO_DAYS = 172800000;

    it('FAILS: ObjectId _id is filtered out by hasId check', function () {
      var ageLimit = Date.now() - TWO_DAYS;
      var doc = {
        _id: new ObjectId(),
        type: 'sgv',
        sgv: 120,
        mills: Date.now() - 3600000
      };
      var result = filterForAge([doc], ageLimit);
      // BUG: entry with valid ObjectId _id is rejected
      result.should.have.length(0);
    });

    it('PASSES: string _id passes hasId check', function () {
      var ageLimit = Date.now() - TWO_DAYS;
      var doc = {
        _id: new ObjectId().toString(),
        type: 'sgv',
        sgv: 120,
        mills: Date.now() - 3600000
      };
      var result = filterForAge([doc], ageLimit);
      result.should.have.length(1);
    });

    it('proposed fix: check _id != null instead of _.isEmpty', function () {
      function filterForAgeFix (data, ageLimit) {
        return _.filter(data, function (object) {
          // Fix: use truthiness check instead of _.isEmpty
          var hasId = object._id != null && object._id !== '';
          var age = object.mills || object.date;
          var isFresh = typeof age === 'number' && age >= ageLimit;
          return isFresh && hasId;
        });
      }

      var ageLimit = Date.now() - TWO_DAYS;
      var doc = {
        _id: new ObjectId(),
        type: 'sgv',
        sgv: 120,
        mills: Date.now() - 3600000
      };
      var result = filterForAgeFix([doc], ageLimit);
      // With the fix, ObjectId _id passes
      result.should.have.length(1);
    });
  });

  describe('mongoCachedCollection data-update path (API3)', function () {

    it('REGRESSION: API3 insertOne emits data-update with ObjectId _id', function () {
      // Simulates what mongoCachedCollection.updateInCache does
      // It passes raw documents (ObjectId _id) to data-update
      // WITHOUT going through processRawDataForRuntime

      var doc = {
        _id: new ObjectId(),
        type: 'sgv',
        sgv: 120,
        date: Date.now() - 7200000, // 2 hours ago
        mills: Date.now() - 7200000
      };

      // Simulate cache.dataChanged with mergeCacheArrays
      var TWO_DAYS = 172800000;
      var ageLimit = Date.now() - TWO_DAYS;

      function filterForAge (data, ageLimit) {
        return _.filter(data, function (object) {
          var hasId = !_.isEmpty(object._id);
          var age = object.mills || object.date;
          var isFresh = typeof age === 'number' && age >= ageLimit;
          return isFresh && hasId;
        });
      }

      var filteredNew = filterForAge([doc], ageLimit);
      // BUG: the ObjectId entry is dropped
      filteredNew.should.have.length(0);
    });
  });
});
