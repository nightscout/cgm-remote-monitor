'use strict';

/**
 * legacy-bridge-boot-errors.test.js
 *
 * Leftover MMCONNECT_* or BRIDGE_* settings that cannot be migrated stop the
 * site with a boot error, by design: they are usually the site's primary data
 * source. That is only useful if the page names a fix, and applying exactly
 * that fix lets the site boot. Settings are resolved through lib/server/env
 * from process environment variables, as on a real deployment, because
 * CONNECT_* settings are only read when connect is in ENABLE.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {createRequire} = require('module');
const {EventEmitter} = require('events');

const config = require('../lib/server/env');

const MANAGED = [
  'ENABLE', 'MMCONNECT_USER_NAME', 'MMCONNECT_PASSWORD', 'MMCONNECT_SERVER',
  'BRIDGE_USER_NAME', 'BRIDGE_PASSWORD', 'CONNECT_SOURCE', 'CONNECT_COUNTRY_CODE',
  'DEXCOM_BRIDGE_USE_LEGACY'
];

// Run the registered setupConnect stage with the connector replaced by a stub.
function boot (vars) {
  const saved = {};
  MANAGED.forEach(key => { saved[key] = process.env[key]; delete process.env[key]; });
  Object.keys(vars).forEach(key => { process.env[key] = vars[key]; });
  try {
    const env = config();
    const filename = path.resolve(__dirname, '../lib/server/bootevent.js');
    const localRequire = createRequire(filename);
    const stages = [];
    const pipeline = {acquire (stage) { stages.push(stage); return pipeline; }};
    const logs = [];
    let started = null;
    const sandbox = {module: {exports: {}}, console: {log (...args) { logs.push(args.join(' ')); }}, process, require (name) {
      if (name === 'bootevent') return () => pipeline;
      if (name === 'nightscout-connect') return configured => { started = configured.extendedSettings.connect.source; return {stop () {}}; };
      return localRequire(name);
    }};
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, {filename});
    sandbox.module.exports(env, {});
    const ctx = {bootErrors: [], bus: new EventEmitter()};
    stages.find(stage => stage.name === 'setupConnect')(ctx, () => {});
    return {errors: ctx.bootErrors.map(e => e.desc), started, logs};
  } finally {
    MANAGED.forEach(key => { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });
  }
}

const MINIMED = {MMCONNECT_USER_NAME: 'fixture-user', MMCONNECT_PASSWORD: 'fixture-password', MMCONNECT_SERVER: 'EU'};
const DEXCOM = {BRIDGE_USER_NAME: 'fixture-user', BRIDGE_PASSWORD: 'fixture-password'};

function stopsWith (result, fragments) {
  assert.strictEqual(result.errors.length, 1, 'expected one boot error, got ' + JSON.stringify(result.errors));
  assert.strictEqual(result.started, null);
  const message = result.errors[0];
  fragments.forEach(fragment => assert.ok(message.includes(fragment), 'boot error does not name ' + fragment + ': ' + message));
  assert.ok(!/15\.0\.9/.test(message), 'boot error names a release number: ' + message);
  assert.ok(!message.includes('fixture-'), 'boot error exposes a credential');
}

function boots (result, source) {
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.started, source);
}

describe('legacy bridge boot errors name a fix that boots', function () {

  it('MiniMed without a country: adding connect to ENABLE and setting CONNECT_COUNTRY_CODE boots', function () {
    stopsWith(boot({ENABLE: 'mmconnect', ...MINIMED}), ['connect to ENABLE', 'CONNECT_COUNTRY_CODE']);
    boots(boot({ENABLE: 'mmconnect connect', ...MINIMED, CONNECT_COUNTRY_CODE: 'GB'}), 'minimedcarelink');
  });

  it('MiniMed with a country but without connect in ENABLE still stops, which is why the message names ENABLE', function () {
    stopsWith(boot({ENABLE: 'mmconnect', ...MINIMED, CONNECT_COUNTRY_CODE: 'GB'}), ['connect to ENABLE']);
  });

  it('Dexcom and MiniMed together: either fix the message names boots', function () {
    const vars = {ENABLE: 'bridge mmconnect connect', ...DEXCOM, ...MINIMED, CONNECT_COUNTRY_CODE: 'GB'};
    stopsWith(boot(vars), ['remove the MMCONNECT_* settings and mmconnect from ENABLE', 'CONNECT_SOURCE=minimedcarelink', 'CONNECT_COUNTRY_CODE']);
    boots(boot({ENABLE: 'bridge connect', ...DEXCOM, CONNECT_COUNTRY_CODE: 'GB'}), 'dexcomshare');
    boots(boot({ENABLE: 'mmconnect connect', ...MINIMED, CONNECT_SOURCE: 'minimedcarelink', CONNECT_COUNTRY_CODE: 'GB'}), 'minimedcarelink');
  });

  it('Dexcom alongside another CONNECT_SOURCE: either fix the message names boots', function () {
    stopsWith(boot({ENABLE: 'bridge connect', ...DEXCOM, CONNECT_SOURCE: 'glooko'}), ['remove the BRIDGE_* settings and bridge from ENABLE', 'CONNECT_SOURCE=dexcomshare']);
    boots(boot({ENABLE: 'connect', CONNECT_SOURCE: 'glooko'}), 'glooko');
    boots(boot({ENABLE: 'bridge connect', ...DEXCOM, CONNECT_SOURCE: 'dexcomshare'}), 'dexcomshare');
  });

  it('says DEXCOM_BRIDGE_USE_LEGACY is ignored, and Dexcom still arrives through Connect', function () {
    const result = boot({ENABLE: 'bridge', ...DEXCOM, DEXCOM_BRIDGE_USE_LEGACY: 'true'});
    boots(result, 'dexcomshare');
    assert.ok(result.logs.some(line => line.includes('DEXCOM_BRIDGE_USE_LEGACY is no longer supported and is ignored')), 'no log line says the override is ignored: ' + JSON.stringify(result.logs));
  });

  it('does not mention DEXCOM_BRIDGE_USE_LEGACY when it is not set', function () {
    const result = boot({ENABLE: 'bridge', ...DEXCOM});
    boots(result, 'dexcomshare');
    assert.ok(!result.logs.some(line => line.includes('DEXCOM_BRIDGE_USE_LEGACY')));
  });
});
