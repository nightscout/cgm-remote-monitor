'use strict';

var should = require('should');
var compat = require('../lib/server/bridge-connect-compat');

describe('bridge connect compatibility', function () {
  afterEach(function () {
    delete process.env.DEXCOM_BRIDGE_USE_LEGACY;
    delete process.env.CUSTOMCONNSTR_DEXCOM_BRIDGE_USE_LEGACY;
  });

  it('maps legacy bridge credentials to connect dexcomshare', function () {
    var env = {
      extendedSettings: {
        bridge: {
          userName: 'dexcom-user',
          password: 'dexcom-pass',
          server: 'EU'
        }
      }
    };

    var result = compat.applyBridgeToConnectCompatibility(env);

    result.migrated.should.equal(true);
    env.extendedSettings.connect.source.should.equal('dexcomshare');
    env.extendedSettings.connect.shareAccountName.should.equal('dexcom-user');
    env.extendedSettings.connect.sharePassword.should.equal('dexcom-pass');
    env.extendedSettings.connect.shareRegion.should.equal('ous');
  });

  it('preserves explicit connect settings over bridge settings', function () {
    var env = {
      extendedSettings: {
        bridge: {
          userName: 'bridge-user',
          password: 'bridge-pass',
          server: 'EU'
        },
        connect: {
          source: 'dexcomshare',
          shareAccountName: 'connect-user',
          sharePassword: 'connect-pass',
          shareServer: 'custom.share.example'
        }
      }
    };

    compat.applyBridgeToConnectCompatibility(env);

    env.extendedSettings.connect.shareAccountName.should.equal('connect-user');
    env.extendedSettings.connect.sharePassword.should.equal('connect-pass');
    env.extendedSettings.connect.shareServer.should.equal('custom.share.example');
    should.not.exist(env.extendedSettings.connect.shareRegion);
  });

  it('does not migrate when legacy bridge is explicitly requested', function () {
    var env = {
      extendedSettings: {
        bridge: {
          userName: 'dexcom-user',
          password: 'dexcom-pass'
        }
      }
    };
    process.env.DEXCOM_BRIDGE_USE_LEGACY = 'true';

    var result = compat.applyBridgeToConnectCompatibility(env);

    result.legacy.should.equal(true);
    should.not.exist(env.extendedSettings.connect);
  });

  it('does not override non-Dexcom connect sources', function () {
    var env = {
      extendedSettings: {
        bridge: {
          userName: 'dexcom-user',
          password: 'dexcom-pass'
        },
        connect: {
          source: 'glooko'
        }
      }
    };

    var result = compat.applyBridgeToConnectCompatibility(env);

    result.migrated.should.equal(false);
    env.extendedSettings.connect.source.should.equal('glooko');
  });
});
