/* jshint node: true */
/* globals describe, it */
'use strict';

var _ = require('lodash'),
  should = require('should');

describe('mmconnect', function () {
  var mmconnect = require('../lib/plugins/mmconnect');

  var env = {
    extendedSettings: {
      mmconnect: {
        // 'userName' for consistency with the bridge plugin
        userName: 'nightscout'
        , password: 'wearenotwaiting'
        , sgvLimit: '99'
        , interval: '12000'
        , maxRetryDuration: 1024
        , verbose: 'true'
      }
    }
  };

  describe('init()', function () {
    it('should create a runner if env vars are present', function () {
      var runner = mmconnect.init(env);
      should.exist(runner);
      should.exist(runner.run);
      runner.run.should.be.instanceof(Function);
    });

    it('should not create a runner if any env vars are absent', function () {
      [
        {}
        , {mmconnect: {}}
        , {mmconnect: {userName: 'nightscout'}}
        , {mmconnect: {password: 'wearenotwaiting'}}
      ].forEach(function (extendedSettings) {
        should.not.exist(mmconnect.init({extendedSettings: extendedSettings}));
      });
    });
  });


  describe('getOptions()', function () {
    it('should set the carelink client config from env', function () {
      mmconnect.getOptions(env).should.have.properties({
        username: 'nightscout'
        , password: 'wearenotwaiting'
        , sgvLimit: 99
        , interval: 12000
        , maxRetryDuration: 1024
        , verbose: true
      });
    });

  });

  describe('makeRecentSgvFilter()', function () {
    function sgv(date) {
      return {type: 'sgv', date: date};
    }
    function pumpStatus(date) {
      return {type: 'pump_status', date: date};
    }

    it('should return a stateful filter which discards sgvs older than the most recent one seen', function() {
      var filter = mmconnect.makeRecentSgvFilter();

      filter([2, 3, 4].map(sgv)).length.should.equal(3);

      filter([2, 3, 4].map(sgv)).length.should.equal(0);

      var filtered = filter([1, 2, 3, 4, 5, 6].map(sgv));
      filtered.length.should.equal(2);
      _.pluck(filtered, 'date').should.containEql(5);
      _.pluck(filtered, 'date').should.containEql(6);
    });

    it('should return a stateful filter which allows non-sgv entries to be old', function() {
      var filter = mmconnect.makeRecentSgvFilter();

      filter([2, 3, 4].map(sgv)).length.should.equal(3);

      filter([1, 2, 3, 4, 5].map(pumpStatus)).length.should.equal(5);

      var filtered = filter(
        [1, 2, 3, 4, 5].map(pumpStatus).concat(
          [3, 4, 5, 6, 7].map(sgv)
        )
      );
      _.filter(filtered, {type: 'pump_status'}).length.should.equal(5);
      _.filter(filtered, {type: 'sgv'}).length.should.equal(3);
    });
  });

  describe('rawDataEntry()', function () {
    it('should generate a "carelink_raw" entry with sgs truncated and PII redacted', function () {
      var data = {
        'lastMedicalDeviceDataUpdateServerTime': 1445471797479
        , 'sgs': _.range(10)
        , 'firstName': 'sensitive'
        , 'lastName': 'sensitive'
        , 'medicalDeviceSerialNumber': 'sensitive'
      };
      var entry = mmconnect.rawDataEntry(data);
      entry.should.have.properties({
        'date': 1445471797479
        , 'type': 'carelink_raw'
      });
      entry.data.should.have.properties({
        'firstName': '<redacted>'
        , 'lastName': '<redacted>'
        , 'medicalDeviceSerialNumber': '<redacted>'
      });
      entry.data.sgs.length.should.equal(6);
    });
  });

});
