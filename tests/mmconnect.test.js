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
