/* jshint node: true */
'use strict';

var should = require('should');

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

  describe('init()', function() {

    it('should create a runner if env vars are present', function() {
      var runner = mmconnect.init(env);
      should.exist(runner);
      should.exist(runner.run);
      runner.run.should.be.instanceof(Function);
    });

    it('should not create a runner if any env vars are absent', function() {
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


  describe('getOptions_()', function() {

    it('should set the carelink client config from env', function() {
      mmconnect.getOptions_(env).should.have.properties({
        username: 'nightscout'
        , password: 'wearenotwaiting'
        , sgvLimit: 99
        , interval: 12000
        , maxRetryDuration: 1024
        , verbose: true
      });
    });

  });

});
