'use strict';

const assert = require('assert');
const {spawnSync} = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
const supported = require('../package.json').engines.node;

function probe(version, entry) {
  return spawnSync(process.execPath, ['-e', `
    Object.defineProperty(process, 'version', {value: ${JSON.stringify(version)}});
    const Module = require('module');
    const original = Module._load;
    Module._load = function (name) {
      if (name === './env' || name === '../bus' || name === '../storage/mongo-storage') {
        throw new Error('Loaded application services before checking Node');
      }
      return original.apply(this, arguments);
    };
    ${entry}
    console.log('runtime accepted');
  `], {cwd: root, encoding: 'utf8', timeout: 5000});
}

describe('Node runtime policy', function () {
  ['v22.23.2', 'v22.24.0', 'v24.20.0', 'v24.21.0'].forEach(version => {
    it('accepts supported LTS ' + version, function () {
      const result = probe(version, "require('./lib/server/runtime-policy')();");
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /runtime accepted/);
    });
  });

  ['v16.20.2', 'v20.20.0', 'v22.0.0', 'v22.23.1', 'v23.0.0', 'v24.19.0', 'v24.20.0-rc.1', 'v25.0.0', 'v26.8.1'].forEach(version => {
    ['lib/server/server.js', 'server.js'].forEach(entry => {
      it('rejects ' + version + ' before startup through ' + entry, function () {
        const result = probe(version, 'require(' + JSON.stringify('./' + entry) + ');');
        assert.strictEqual(result.status, 1, result.stderr);
        assert.ok(result.stderr.includes(supported), result.stderr);
        assert.ok(result.stderr.includes(version), result.stderr);
        assert.doesNotMatch(result.stderr, /Loaded application services/);
        assert.doesNotMatch(result.stdout, /runtime accepted/);
      });
    });
  });

  it('rejects unsupported runtime before the public boot API starts the bus', function () {
    const result = probe('v20.20.0', "require('./lib/server/bootevent')({}, {}).boot(function () { throw new Error('booted'); });");
    assert.strictEqual(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(supported), result.stderr);
    assert.doesNotMatch(result.stderr, /Loaded application services|booted/);
  });
});
