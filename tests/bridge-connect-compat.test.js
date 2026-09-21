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

  it('migrates even when the retired legacy override is set', function () {
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

    result.migrated.should.equal(true);
    env.extendedSettings.connect.source.should.equal('dexcomshare');
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
    result.error.should.match(/retired.*15\.0\.9/);
    env.extendedSettings.connect.source.should.equal('glooko');
    should.not.exist(env.extendedSettings.connect.sharePassword);
  });
  it('preserves custom server and explicit credentials over repeated migration', function () {
    const env = {extendedSettings: {bridge: {userName:'old-user',password:'old-pass',server:'owned.share.example'},
      connect: {source:'dexcomshare',shareAccountName:'explicit-user',sharePassword:'explicit-pass'}}};
    for (let cycle=0;cycle<2;cycle++) {
      compat.applyBridgeToConnectCompatibility(env).migrated.should.equal(true);
      env.extendedSettings.connect.shareServer.should.equal('owned.share.example');
      env.extendedSettings.connect.shareAccountName.should.equal('explicit-user');
      env.extendedSettings.connect.sharePassword.should.equal('explicit-pass');
    }
  });

  it('does not enable Connect from absent or incomplete bridge credentials', function () {
    for (const bridge of [{}, {userName:'partial'}, {password:'partial'}]) {
      const env={extendedSettings:{bridge}};
      compat.applyBridgeToConnectCompatibility(env).migrated.should.equal(false);
      should.not.exist(env.extendedSettings.connect);
    }
  });

  it('maps the legacy US selector to the real US region over repeated migration', function () {
    const source = require('nightscout-connect/lib/sources/dexcomshare');
    for (const server of ['US', 'us', 'Us']) {
      const env = {extendedSettings: {bridge: {userName: 'owned-user', password: 'owned-password', server}}};
      for (let cycle = 0; cycle < 2; cycle++) {
        compat.applyBridgeToConnectCompatibility(env).migrated.should.equal(true);
        env.extendedSettings.connect.shareRegion.should.equal('us');
        should.not.exist(env.extendedSettings.connect.shareServer);
        source.validate(env.extendedSettings.connect).config.baseURL.should.equal('https://share2.dexcom.com');
      }
    }
  });

});
