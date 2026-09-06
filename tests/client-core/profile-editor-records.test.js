'use strict';
require('should');

var records = require('../../lib/client-core/profile-editor/records');
var buildDefaultProfile = require('../../lib/client-core/profile-editor/default-profile');

describe('client-core: profile-editor / records CRUD', function () {

  function seed () {
    return [records.newEmptyRecord(buildDefaultProfile())];
  }

  describe('newEmptyRecord', function () {
    it('builds a record with Default profile and current ISO startDate', function () {
      var r = records.newEmptyRecord(buildDefaultProfile());
      r.defaultProfile.should.equal('Default');
      r.store.should.have.property('Default');
      r.store.Default.dia.should.equal(3);
      // startDate should be a valid ISO from "now" (tolerate 5 sec)
      Math.abs(Date.now() - new Date(r.startDate).getTime()).should.be.below(5000);
    });
  });

  describe('addRecord', function () {
    it('appends and points currentIndex at the new record', function () {
      var arr = seed();
      var res = records.addRecord(arr, buildDefaultProfile());
      res.records.length.should.equal(2);
      res.currentIndex.should.equal(1);
      res.currentProfile.should.equal('Default');
    });
  });

  describe('removeRecord', function () {
    it('refuses to remove the only record (length<=1)', function () {
      var arr = seed();
      var res = records.removeRecord(arr, 0);
      res.removed.should.be.false();
      arr.length.should.equal(1);
    });

    it('removes when length>1 and resets currentIndex to 0', function () {
      var arr = seed();
      records.addRecord(arr, buildDefaultProfile());
      records.addRecord(arr, buildDefaultProfile());
      arr[0]._id = 'first';
      arr[1]._id = 'second';
      arr[2]._id = 'third';
      var res = records.removeRecord(arr, 2);
      res.removed.should.be.true();
      res.currentIndex.should.equal(0);
      res.currentProfile.should.equal('Default');
      arr.length.should.equal(2);
      arr.map(function (r) { return r._id; }).should.eql(['first', 'second']);
    });
  });

  describe('cloneRecord', function () {
    it('appends a sibling stripped of persistence keys with a fresh startDate', function () {
      var arr = seed();
      arr[0]._id = 'mongo-oid-1';
      arr[0].srvModified = 1234;
      arr[0].srvCreated = 1000;
      arr[0].identifier = 'uuid-x';
      arr[0].mills = 9999;
      arr[0].extra = 'keep-me';
      arr[0].startDate = '1970-01-01T00:00:00.000Z'; // force a known past timestamp
      var origStart = arr[0].startDate;
      var res = records.cloneRecord(arr, 0);
      res.currentIndex.should.equal(1);
      var clone = arr[1];
      clone.should.not.have.property('_id');
      clone.should.not.have.property('srvModified');
      clone.should.not.have.property('srvCreated');
      clone.should.not.have.property('identifier');
      clone.should.not.have.property('mills');
      clone.extra.should.equal('keep-me');
      clone.startDate.should.not.equal(origStart);
    });
  });
});
