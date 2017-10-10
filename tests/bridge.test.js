'use strict';

var should = require('should');

describe('bridge', function ( ) {
  var bridge = require('../lib/plugins/bridge');

  var env = {
    extendedSettings: {
      bridge: {
        userName: 'nightscout'
        , password: 'wearenotwaiting'
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

});
