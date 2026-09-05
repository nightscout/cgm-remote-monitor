'use strict';

// Module paths below come only from the committed lockfile.
/* eslint-disable security/detect-non-literal-require */

const assert = require('assert');
const path = require('path');
const { createRequire } = require('module');
const semver = require('semver');
const lock = require('../package-lock.json');
const root = path.resolve(__dirname, '..');
const packages = Object.entries(lock.packages);

// Include the final resource-limit fixes on each supported API line.
// A global 5.x override breaks minimatch 3/5/9, which call a function export.
const patchedRanges = {
  1: '>=1.1.18 <2',
  2: '>=2.1.4 <3',
  5: '>=5.0.9 <6'
};

describe('brace-expansion dependency regressions', function () {
  const copies = packages.filter(([name]) => name.endsWith('/brace-expansion'));

  it('finds the locked dependency copies', function () {
    assert.ok(copies.length > 0);
  });

  copies.forEach(([packagePath, entry]) => {
    describe(packagePath, function () {
      const installedPath = path.join(root, packagePath);
      const installed = require(path.join(installedPath, 'package.json'));
      const api = require(installedPath);
      const expand = typeof api === 'function' ? api : api.expand;

      it('installs a patched version matching the lockfile', function () {
        const range = patchedRanges[semver.major(installed.version)];
        assert.strictEqual(installed.version, entry.version);
        assert.ok(range && semver.satisfies(installed.version, range),
          packagePath + ' contains an unreviewed version: ' + installed.version);
      });

      it('preserves ordinary nested alternatives, padding and escaped braces', function () {
        assert.deepStrictEqual(expand('file-{a,{b,c}}.js'),
          ['file-a.js', 'file-b.js', 'file-c.js']);
        assert.deepStrictEqual(expand('file{03..01}.js'),
          ['file03.js', 'file02.js', 'file01.js']);
        assert.deepStrictEqual(expand('\\{a,b\\}'), ['{a,b}']);
        assert.deepStrictEqual(expand('x{a,,b}y'), ['xay', 'xy', 'xby']);
      });

      it('bounds default expansion count and keeps nonempty alternatives', function () {
        assert.strictEqual(expand('{1..100001}').length, 100000);
        assert.deepStrictEqual(expand('{a,,b}', { max: 2 }), ['a', 'b']);
      });

      it('bounds expansion length while generating padded sequences', function () {
        assert.deepStrictEqual(expand('prefix{a,b}{1,2}', { maxLength: 8 }), ['prefixa1']);
        // Unbounded output is just over 6 MB, so a regression fails safely.
        const results = expand('{' + '0'.repeat(2000) + '1..3000}');
        assert.ok(results.length > 0);
        assert.ok(results.reduce((length, value) => length + value.length, 0) <= 4000000);
      });
    });
  });

  packages.filter(([, entry]) => entry.dependencies && entry.dependencies['brace-expansion'])
    .forEach(([packagePath, entry]) => {
      it('preserves the brace-expansion contract for ' + packagePath, function () {
        const consumerRequire = createRequire(path.join(root, packagePath, 'package.json'));
        const installed = consumerRequire('brace-expansion/package.json');
        assert.ok(semver.satisfies(installed.version, entry.dependencies['brace-expansion']),
          packagePath + ' resolved an incompatible brace-expansion major');
        if (packagePath.endsWith('/minimatch')) {
          const api = require(path.join(root, packagePath));
          const match = typeof api === 'function' ? api : api.minimatch;
          assert.strictEqual(match('file02.js', 'file{01..03}.js'), true);
          assert.strictEqual(match('file04.js', 'file{01..03}.js'), false);
          assert.strictEqual(match('tests/api3.security.test.js', 'tests/{api,api3}.*.test.js'), true);
        }
      });
    });

  it('preserves file selection through the production EJS/Jake/FileList chain', function () {
    const ejsRequire = createRequire(require.resolve('ejs'));
    const jakeRequire = createRequire(ejsRequire.resolve('jake'));
    const { FileList } = jakeRequire('filelist');
    const files = new FileList();
    files.include(path.join(__dirname, '{api,api3}.security.test.js'));
    assert.deepStrictEqual(files.toArray().sort(), [
      path.join(__dirname, 'api.security.test.js'),
      path.join(__dirname, 'api3.security.test.js')
    ]);
  });
});
