'use strict';

var should = require('should');

describe('bridge', function ( ) {
  var bridge = require('../lib/plugins/bridge');

  var env = {
    extendedSettings: {
      bridge: {
        userName: 'nightscout'
        , password: 'wearenotwaiting'
        , interval: 60000
      }
    }
  };

  it('be creatable', function () {
    var configed = bridge(env);
    should.exist(configed);
    should.exist(configed.startEngine);
    should.exist(configed.startEngine.call);
  });

  it('set options from env', function () {
    var opts = bridge.options(env);
    should.exist(opts);

    opts.login.accountName.should.equal('nightscout');
    opts.login.password.should.equal('wearenotwaiting');
    opts.interval.should.equal(60000);
  });

  it('store entries from share', function (done) {
    var mockEntries = {
      create: function mockCreate (err, callback) {
        callback(null);
        done();
      }
    };
    bridge.bridged(mockEntries)(null);
  });

  it('set too low bridge interval option from env', function () {
    var tooLowInterval = {
      extendedSettings: {
        bridge: { interval: 900 }
      }
    };

    var opts = bridge.options(tooLowInterval);
    should.exist(opts);

    opts.interval.should.equal(156000);
  });

  it('set too high bridge interval option from env', function () {
    var tooHighInterval = {
      extendedSettings: {
        bridge: { interval: 500000 }
      }
    };

    var opts = bridge.options(tooHighInterval);
    should.exist(opts);

    opts.interval.should.equal(156000);
  });

  it('set no bridge interval option from env', function () {
    var noInterval = {
      extendedSettings: {
        bridge: { }
      }
    };

    var opts = bridge.options(noInterval);
    should.exist(opts);

    opts.interval.should.equal(156000);
  });

});
