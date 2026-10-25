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
  it('runs on an actually supported runtime', function () {
    assert.ok(require('semver').satisfies(process.version, supported),
      'Use a patched Node runtime matching ' + supported + '; got ' + process.version);
  });

  // The security floor includes the Brotli fix for CVE-2026-111497.
  // Later stable majors remain allowed, as in the previous runtime policy.
  ['v22.23.4', 'v22.24.0', 'v24.22.1', 'v24.23.0', 'v26.12.1', 'v26.13.0', 'v27.0.0'].forEach(version => {
    it('accepts supported release ' + version, function () {
      const result = probe(version, "require('./lib/server/runtime-policy')();");
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /runtime accepted/);
    });
  });

  // Check the immediately preceding vulnerable patch on each maintained line,
  // older releases and the unpatched Node 25 line. Prereleases remain excluded.
  ['v16.20.2', 'v18.20.8', 'v20.20.0', 'v22.0.0', 'v22.11.1', 'v22.23.3',
    'v23.0.0', 'v24.0.0', 'v24.22.0', 'v25.2.1', 'v26.0.0', 'v26.12.0',
    'v22.23.4-rc.1', 'v24.22.1-rc.1', 'v26.12.1-rc.1'].forEach(version => {
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

  ['v20.20.0', 'v22.23.3', 'v24.22.0', 'v25.2.1', 'v26.12.0'].forEach(version => {
    it('rejects ' + version + ' before the public boot API starts the bus', function () {
      const result = probe(version, "require('./lib/server/bootevent')({}, {}).boot(function () { throw new Error('booted'); });");
      assert.strictEqual(result.status, 1, result.stderr);
      assert.ok(result.stderr.includes(supported), result.stderr);
      assert.doesNotMatch(result.stderr, /Loaded application services|booted/);
    });
  });
});
