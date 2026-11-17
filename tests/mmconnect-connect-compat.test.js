'use strict';
const assert = require('node:assert/strict');
const {applyMmconnectToConnectCompatibility: migrate} = require('../lib/server/mmconnect-connect-compat');

function configured(server) {
  return {extendedSettings: {mmconnect: {userName: 'owned-user', password: 'owned-password', server}, connect: {countryCode: 'gb'}}};
}

describe('retired MiniMed bridge compatibility', function () {
  it('maps complete legacy credentials and supported regions without guessing the country', function () {
    for (const server of ['EU', 'eu', 'Us', 'US']) {
      const env = configured(server);
      assert.equal(migrate(env).migrated, true);
      assert.deepEqual(env.extendedSettings.connect, {source: 'minimedcarelink', carelinkUsername: 'owned-user', carelinkPassword: 'owned-password', countryCode: 'gb', carelinkRegion: server.toLowerCase()});
      const first = JSON.stringify(env);
      assert.equal(migrate(env).migrated, true);
      assert.equal(JSON.stringify(env), first);
    }
  });
  it('preserves explicit Connect credentials, country, patient and server', function () {
    const env = configured('EU');
    const explicit = {source: 'minimedcarelink', carelinkUsername: 'explicit-user', carelinkPassword: 'explicit-password', countryCode: 'fr', carelinkPatientUsername: 'patient', carelinkServer: 'owned.example'};
    env.extendedSettings.connect = {...explicit};
    assert.equal(migrate(env).migrated, true);
    assert.deepEqual(env.extendedSettings.connect, explicit);
  });
  it('preserves explicit Connect region over legacy server', function () {
    const env = configured('EU');
    env.extendedSettings.connect.carelinkRegion = 'us';
    migrate(env);
    assert.equal(env.extendedSettings.connect.carelinkRegion, 'us');
    assert.equal(env.extendedSettings.connect.carelinkServer, undefined);
  });
  it('maps a custom legacy server', function () {
    const env = configured('owned.example');
    migrate(env);
    assert.equal(env.extendedSettings.connect.carelinkServer, 'owned.example');
    assert.equal(env.extendedSettings.connect.carelinkRegion, undefined);
  });
  it('fails without country before changing settings or exposing credentials', function () {
    const env = configured('EU');
    delete env.extendedSettings.connect;
    const before = JSON.stringify(env);
    const result = migrate(env);
    assert.equal(result.migrated, false);
    assert.match(result.error, /CONNECT_COUNTRY_CODE/);
    assert.ok(!result.error.includes('owned-'));
    assert.equal(JSON.stringify(env), before);
  });
  it('rejects a conflicting source without changing settings or exposing credentials', function () {
    const env = configured('EU');
    env.extendedSettings.connect.source = 'dexcomshare';
    const before = JSON.stringify(env);
    const result = migrate(env);
    assert.equal(result.migrated, false);
    assert.match(result.error, /different CONNECT_SOURCE/);
    assert.ok(!result.error.includes('owned-'));
    assert.equal(JSON.stringify(env), before);
  });
  it('does not enable incomplete or absent legacy configuration', function () {
    for (const env of [{}, {extendedSettings: {}}, {extendedSettings: {mmconnect: {userName: 'owned-user'}}}, {extendedSettings: {mmconnect: {password: 'owned-password'}}}]) {
      const before = JSON.stringify(env);
      assert.deepEqual(migrate(env), {migrated: false});
      assert.equal(JSON.stringify(env), before);
    }
  });
});
