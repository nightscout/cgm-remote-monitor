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
  // Boundary updated with the floor: engines is ^22.12 || >=24. 22.12.0 is the exact
  // lower bound and is where require(esm) is unflagged, which is the real dependency
  // constraint (sanitize-html requires the ESM-only htmlparser2). The old patch floor
  // ^22.23.2 || ^24.20.0 rejected these and nothing measured justified it.
  ['v22.12.0', 'v22.22.0', 'v22.23.2', 'v22.24.0', 'v24.0.0', 'v24.20.0', 'v24.21.0'].forEach(version => {
    it('accepts supported LTS ' + version, function () {
      const result = probe(version, "require('./lib/server/runtime-policy')();");
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /runtime accepted/);
    });
  });

  // Still refused, and each for a stated reason: 16/18 predate require(esm); 20 reached
  // end of life 2026-04-30 (it WORKS -- measured 310 passing / 0 failing -- and is
  // deliberately not supported rather than deliberately broken); 22.0-22.11 predate
  // require(esm); 23 is an odd major BELOW the >=24 arm; prereleases never satisfy a
  // range unless the range says so, which is semver's default and is relied on here.
  //
  // DELIBERATELY ABSENT, and it is a real consequence of `>= 24`: v25.x and v26.x are
  // ACCEPTED. The previous policy document excluded "odd-numbered releases" and "Node 26
  // Current" by name, and the wider range no longer does. That is the maintainer's call
  // (2026-09-21) and it follows from the position that over-restricting has cost this
  // project more than permissiveness has. If odd majors should be refused, the range needs
  // an explicit upper arm -- `^22.12 || ^24 || ^26` -- and this list gets v25.0.0 back.
  ['v16.20.2', 'v18.20.8', 'v20.20.0', 'v22.0.0', 'v22.11.1', 'v23.0.0', 'v24.20.0-rc.1'].forEach(version => {
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
