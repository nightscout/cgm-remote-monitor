'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// API v3's settings are read in lib/server/env.js (BF-46). The reading must be
// the one lib/api3/index.js did itself before: four spellings, the value as
// written (no trimming), true/on and false/off as booleans, anything else kept.
describe('API v3 settings are read by env.js', function () {
  const NAMES = [
    'API3_SECURITY_ENABLE', 'API3_DEDUP_FALLBACK_ENABLED', 'API3_CREATED_AT_FALLBACK_ENABLED', 'API3_MAX_LIMIT'
    , 'API3_AUTOPRUNE_DEVICESTATUS', 'API3_AUTOPRUNE_ENTRIES', 'API3_AUTOPRUNE_FOOD'
    , 'API3_AUTOPRUNE_PROFILE', 'API3_AUTOPRUNE_SETTINGS', 'API3_AUTOPRUNE_TREATMENTS'
  ];
  const ALL_KEYS = [];
  NAMES.concat(['CI']).forEach(name => {
    ALL_KEYS.push(name, name.toLowerCase(), 'CUSTOMCONNSTR_' + name, 'CUSTOMCONNSTR_' + name.toLowerCase());
  });

  let saved;
  beforeEach(function () {
    saved = {};
    ALL_KEYS.forEach(key => { saved[key] = process.env[key]; delete process.env[key]; });
  });
  afterEach(function () {
    ALL_KEYS.forEach(key => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  });

  // lib/api3/index.js setENVTruthy as it was on dev b29f1bf7, as the oracle.
  function previousReading (varName, defaultValue) {
    let value = process.env['CUSTOMCONNSTR_' + varName]
      || process.env['CUSTOMCONNSTR_' + varName.toLowerCase()]
      || process.env[varName]
      || process.env[varName.toLowerCase()];
    value = value != null ? value : defaultValue;
    if (typeof value === 'string' && (value.toLowerCase() === 'on' || value.toLowerCase() === 'true')) { value = true; }
    if (typeof value === 'string' && (value.toLowerCase() === 'off' || value.toLowerCase() === 'false')) { value = false; }
    return value;
  }

  const apiConst = require('../lib/api3/const.json');
  const defaults = {
    API3_SECURITY_ENABLE: apiConst.API3_SECURITY_ENABLE
    , API3_DEDUP_FALLBACK_ENABLED: apiConst.API3_DEDUP_FALLBACK_ENABLED
    , API3_CREATED_AT_FALLBACK_ENABLED: apiConst.API3_CREATED_AT_FALLBACK_ENABLED
    , API3_MAX_LIMIT: apiConst.API3_MAX_LIMIT
  };

  it('has the documented defaults when nothing is set', function () {
    const env = require('../lib/server/env')();
    assert.deepEqual(env.api3, {
      API3_SECURITY_ENABLE: true
      , API3_DEDUP_FALLBACK_ENABLED: true
      , API3_CREATED_AT_FALLBACK_ENABLED: true
      , API3_MAX_LIMIT: 1000
      , CI: false
      , API3_AUTOPRUNE_DEVICESTATUS: undefined
      , API3_AUTOPRUNE_ENTRIES: undefined
      , API3_AUTOPRUNE_FOOD: undefined
      , API3_AUTOPRUNE_PROFILE: undefined
      , API3_AUTOPRUNE_SETTINGS: undefined
      , API3_AUTOPRUNE_TREATMENTS: undefined
    });
  });

  it('reads every value the way API v3 read it before, in all four spellings', function () {
    const { readApi3Settings } = require('../lib/server/env');
    const values = ['true', 'TRUE', 'on', 'On', 'false', 'off', 'OFF', 'False', ' false', 'false ', '0', 'no', ''
      , '30', '0.5', '-1', '500', 'abc'];
    const spellings = [name => name, name => name.toLowerCase()
      , name => 'CUSTOMCONNSTR_' + name, name => 'CUSTOMCONNSTR_' + name.toLowerCase()];
    for (const name of NAMES) {
      for (const spell of spellings) {
        for (const value of values) {
          process.env[spell(name)] = value;
          assert.deepEqual(readApi3Settings()[name], previousReading(name, defaults[name])
            , name + ' as ' + spell(name) + '=' + JSON.stringify(value));
          delete process.env[spell(name)];
        }
      }
    }
  });

  it('prefers the CUSTOMCONNSTR_ spellings, as before', function () {
    const { readApi3Settings } = require('../lib/server/env');
    process.env.API3_MAX_LIMIT = '200';
    process.env.CUSTOMCONNSTR_api3_max_limit = '300';
    assert.equal(readApi3Settings().API3_MAX_LIMIT, '300');
    process.env.CUSTOMCONNSTR_API3_MAX_LIMIT = '400';
    assert.equal(readApi3Settings().API3_MAX_LIMIT, '400');
    assert.equal(previousReading('API3_MAX_LIMIT', 1000), '400');
  });

  it('reads CI only in upper case, set to anything', function () {
    const { readApi3Settings } = require('../lib/server/env');
    process.env.ci = 'true';
    assert.equal(readApi3Settings().CI, false);
    process.env.CI = 'false';
    assert.equal(readApi3Settings().CI, true);
  });

  it('keeps API v3 settings out of the settings list', function () {
    process.env.API3_AUTOPRUNE_ENTRIES = '90';
    const env = require('../lib/server/env')();
    assert.equal(env.api3.API3_AUTOPRUNE_ENTRIES, '90');
    const settingsText = JSON.stringify(env.settings);
    assert.equal(/api3|autoprune/i.test(settingsText), false);
  });

  it('leaves no direct process.env read in lib/api3', function () {
    const root = path.join(__dirname, '..', 'lib', 'api3');
    const offenders = [];
    (function walk (dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && /process\.env\s*[[.]/.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(root, full));
        }
      }
    })(root);
    assert.deepEqual(offenders, []);
  });
});
