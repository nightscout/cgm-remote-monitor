'use strict';

/**
 * cache-objectid-compat.test.js
 *
 * Regression test: MongoDB driver 5.x ObjectId has no enumerable properties,
 * so _.isEmpty(new ObjectId()) returns true.  This broke cache.js
 * filterForAge() which used `!_.isEmpty(object._id)` as the hasId check.
 *
 * Fix: replaced `!_.isEmpty(object._id)` with `object._id != null && object._id !== ''`
 *
 * On mongodb driver 3.x (v15.0.6), Object.keys(new ObjectID()) returned
 * ['_bsontype','id'], making _.isEmpty return false (correct).
 *
 * On mongodb driver 5.x, Object.keys(new ObjectId())
 * returns [], making _.isEmpty return true (incorrect – treats valid
 * ObjectId _id as empty).
 *
 * Affects: lib/server/cache.js filterForAge()
 * Related: AAPS backfill display bug (entries in MongoDB but invisible on chart)
 */

const _ = require('lodash');
const { ObjectId } = require('mongodb');
const should = require('should');

describe('Cache ObjectId compatibility', function () {

  describe('_.isEmpty behavioral change with new ObjectId (root cause)', function () {

    it('_.isEmpty(ObjectId) returns true on driver 5.x (regression)', function () {
      const oid = new ObjectId();
      // driver 5.x ObjectId has no enumerable keys
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

    it('processRawDataForRuntime converts ObjectId to string (existing mitigation)', function () {
      const ddata = require('../lib/data/ddata')();
      const doc = { _id: new ObjectId(), type: 'sgv', sgv: 120, date: Date.now() };
      const processed = ddata.processRawDataForRuntime([doc]);
      (typeof processed[0]._id).should.equal('string');
      _.isEmpty(processed[0]._id).should.equal(false);
    });
  });

  describe('filterForAge fix verification', function () {

    // Reproduce the OLD (broken) logic for comparison
    function filterForAgeOLD (data, ageLimit) {
      return _.filter(data, function (object) {
        var hasId = !_.isEmpty(object._id);
        var age = object.mills || object.date;
        var isFresh = typeof age === 'number' && age >= ageLimit;
        return isFresh && hasId;
      });
    }

    // The FIXED logic (matches cache.js after the fix)
    function filterForAgeFIXED (data, ageLimit) {
      return _.filter(data, function (object) {
        var hasId = object._id != null && object._id !== '';
        var age = object.mills || object.date;
        var isFresh = typeof age === 'number' && age >= ageLimit;
        return isFresh && hasId;
      });
    }

    const TWO_DAYS = 172800000;

    it('OLD: ObjectId _id is rejected (confirms the bug existed)', function () {
      var ageLimit = Date.now() - TWO_DAYS;
      var doc = { _id: new ObjectId(), type: 'sgv', sgv: 120, mills: Date.now() - 3600000 };
      filterForAgeOLD([doc], ageLimit).should.have.length(0);
    });

    it('FIXED: ObjectId _id is accepted', function () {
      var ageLimit = Date.now() - TWO_DAYS;
      var doc = { _id: new ObjectId(), type: 'sgv', sgv: 120, mills: Date.now() - 3600000 };
      filterForAgeFIXED([doc], ageLimit).should.have.length(1);
    });

    it('FIXED: string _id still accepted', function () {
      var ageLimit = Date.now() - TWO_DAYS;
      var doc = { _id: new ObjectId().toString(), type: 'sgv', sgv: 120, mills: Date.now() - 3600000 };
      filterForAgeFIXED([doc], ageLimit).should.have.length(1);
    });

    it('FIXED: null _id still rejected', function () {
      var ageLimit = Date.now() - TWO_DAYS;
      var doc = { _id: null, type: 'sgv', sgv: 120, mills: Date.now() - 3600000 };
      filterForAgeFIXED([doc], ageLimit).should.have.length(0);
    });

    it('FIXED: undefined _id still rejected', function () {
      var ageLimit = Date.now() - TWO_DAYS;
      var doc = { type: 'sgv', sgv: 120, mills: Date.now() - 3600000 };
      filterForAgeFIXED([doc], ageLimit).should.have.length(0);
    });

    it('FIXED: empty string _id still rejected', function () {
      var ageLimit = Date.now() - TWO_DAYS;
      var doc = { _id: '', type: 'sgv', sgv: 120, mills: Date.now() - 3600000 };
      filterForAgeFIXED([doc], ageLimit).should.have.length(0);
    });

    it('FIXED: stale entries (older than retention) still rejected', function () {
      var ageLimit = Date.now() - TWO_DAYS;
      var doc = { _id: new ObjectId(), type: 'sgv', sgv: 120, mills: Date.now() - (TWO_DAYS + 60000) };
      filterForAgeFIXED([doc], ageLimit).should.have.length(0);
    });
  });

  describe('actual cache.js integration', function () {

    var env, ctx, cache;

    beforeEach(function () {
      env = require('../lib/server/env')();
      // Minimal ctx with bus and ddata for cache initialization
      var EventEmitter = require('events');
      ctx = {
        bus: new EventEmitter(),
        ddata: require('../lib/data/ddata')()
      };
      cache = require('../lib/server/cache')(env, ctx);
    });

    it('cache accepts ObjectId _id entries via insertData', function () {
      var entries = [
        { _id: new ObjectId(), type: 'sgv', sgv: 120, date: Date.now() - 3600000, mills: Date.now() - 3600000 },
        { _id: new ObjectId(), type: 'sgv', sgv: 130, date: Date.now() - 3000000, mills: Date.now() - 3000000 }
      ];
      var result = cache.insertData('entries', entries);
      result.should.have.length(2);
    });

    it('cache accepts string _id entries via insertData', function () {
      var entries = [
        { _id: new ObjectId().toString(), type: 'sgv', sgv: 120, date: Date.now() - 3600000, mills: Date.now() - 3600000 }
      ];
      var result = cache.insertData('entries', entries);
      result.should.have.length(1);
    });

    it('cache preserves ObjectId entries across data-update events', function () {
      // Simulate mongoCachedCollection emitting data-update with ObjectId _id
      var doc = { _id: new ObjectId(), type: 'sgv', sgv: 120, date: Date.now() - 3600000, mills: Date.now() - 3600000 };
      ctx.bus.emit('data-update', { type: 'entries', op: 'update', changes: [doc] });
      var result = cache.getData('entries');
      result.should.have.length(1);
      result[0].sgv.should.equal(120);
    });

    it('cache preserves mixed ObjectId and string _id entries', function () {
      var entries = [
        { _id: new ObjectId(), type: 'sgv', sgv: 120, date: Date.now() - 3600000, mills: Date.now() - 3600000 },
        { _id: 'abc123string', type: 'sgv', sgv: 130, date: Date.now() - 3000000, mills: Date.now() - 3000000 }
      ];
      var result = cache.insertData('entries', entries);
      result.should.have.length(2);
    });

    it('cache rejects entries without _id', function () {
      var entries = [
        { type: 'sgv', sgv: 120, date: Date.now() - 3600000, mills: Date.now() - 3600000 }
      ];
      var result = cache.insertData('entries', entries);
      result.should.have.length(0);
    });

    it('data-update with ObjectId _id does not evict existing cache entries', function () {
      // Pre-populate cache with string _id entries (via dataloader path)
      var existing = [
        { _id: new ObjectId().toString(), type: 'sgv', sgv: 100, date: Date.now() - 7200000, mills: Date.now() - 7200000 },
        { _id: new ObjectId().toString(), type: 'sgv', sgv: 110, date: Date.now() - 3600000, mills: Date.now() - 3600000 }
      ];
      cache.insertData('entries', existing);
      cache.getData('entries').should.have.length(2);

      // Now simulate API3 data-update with ObjectId _id
      var newDoc = { _id: new ObjectId(), type: 'sgv', sgv: 140, date: Date.now() - 1800000, mills: Date.now() - 1800000 };
      ctx.bus.emit('data-update', { type: 'entries', op: 'update', changes: [newDoc] });

      var result = cache.getData('entries');
      // All 3 entries should be present (2 existing + 1 new)
      result.should.have.length(3);
    });
  });
});
