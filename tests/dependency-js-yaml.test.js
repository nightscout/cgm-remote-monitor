'use strict';

// Module paths come from installed consumers; fixtures use a new temp directory.
/* eslint-disable security/detect-non-literal-fs-filename */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const { spawnSync } = require('child_process');
const semver = require('semver');
const lock = require('../package-lock.json');

const consumers = ['eslint', '@eslint/eslintrc', '@istanbuljs/load-nyc-config', 'mocha'];
const versions = [
  { consumer: 'eslint', major: 3, method: 'safeLoad', all: 'safeLoadAll', dump: 'safeDump' },
  { consumer: 'mocha', major: 4, method: 'load', all: 'loadAll', dump: 'dump' }
];

function run(program, args, cwd) {
  // Keep parent coverage instrumentation and application settings out of fixtures.
  const env = { NODE_ENV: 'test' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const result = spawnSync(process.execPath, [program, ...args], {
    cwd, env, encoding: 'utf8', timeout: 8000
  });
  assert.ifError(result.error);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

describe('js-yaml dependency compatibility', function () {
  it('installs patched releases within every consumer API range', function () {
    const copies = Object.entries(lock.packages).filter(([name]) => name.endsWith('/js-yaml'));
    assert.ok(copies.length > 0);
    for (const [name, entry] of copies) {
      // eslint-disable-next-line security/detect-non-literal-require
      const installed = require(path.resolve(__dirname, '..', name, 'package.json'));
      assert.strictEqual(installed.version, entry.version);
      assert.ok(semver.satisfies(installed.version, '>=3.15.2 <4 || >=4.3.2 <5'));
    }
    for (const consumer of consumers) {
      const consumerRequire = createRequire(require.resolve(consumer));
      const installed = consumerRequire('js-yaml/package.json');
      // eslint-disable-next-line security/detect-non-literal-require
      const parent = require(consumer + '/package.json');
      assert.ok(semver.satisfies(installed.version, parent.dependencies['js-yaml']));
      assert.strictEqual(typeof consumerRequire('js-yaml')[consumer === 'mocha' ? 'load' : 'safeLoad'], 'function');
    }
  });

  for (const version of versions) {
    describe('js-yaml ' + version.major + '.x', function () {
      const consumerRequire = createRequire(require.resolve(version.consumer));
      const yaml = consumerRequire('js-yaml');
      const load = yaml[version.method];

      it('preserves configuration values, anchors and explicit merge overrides', function () {
        const value = load('base: &base {timeout: 5000, enabled: true}\nconfig:\n  <<: *base\n  timeout: 3000\n  label: "off"\n');
        assert.deepStrictEqual(value.config, { timeout: 3000, enabled: true, label: 'off' });
        assert.deepStrictEqual(load(yaml[version.dump](value)), value);
      });

      it('keeps plain numeric options numeric and preserves the reviewed underscore behavior', function () {
        const value = load('timeout: 5000\nunderscored: 5_000\n');
        assert.strictEqual(value.timeout, 5000);
        assert.strictEqual(value.underscored, version.major === 3 ? 5000 : '5_000');
      });

      it('rejects merge sequences above 100 entries while accepting the boundary', function () {
        const input = count => 'config: {<<: [' + Array(count).fill('{}').join(',') + ']}';
        assert.deepStrictEqual(load(input(100)), { config: {} });
        assert.throws(() => load(input(101)), /abnormal merge sequence size/);
      });

      it('charges empty mappings against the merge work budget', function () {
        const input = 'base: &base {}\nconfig: {<<: [*base, *base, *base]}';
        assert.deepStrictEqual(load(input, { maxTotalMergeKeys: 3 }).config, {});
        assert.throws(() => load(input, { maxTotalMergeKeys: 2 }), /maxTotalMergeKeys/);
      });

      it('bounds merge work across multiple documents in one call', function () {
        const input = 'config: {<<: {enabled: true}}\n---\nconfig: {<<: {enabled: false}}';
        const loadAll = yaml[version.all];
        assert.strictEqual(loadAll(input, { maxTotalMergeKeys: 4 }).length, 2);
        assert.throws(() => loadAll(input, { maxTotalMergeKeys: 3 }), /maxTotalMergeKeys/);
      });

      it('keeps prototype-named keys as data when merging', function () {
        const value = load('base: &base {__proto__: {polluted: true}, constructor: ordinary}\nconfig: {<<: *base}');
        assert.strictEqual(Object.getPrototypeOf(value.config), Object.prototype);
        assert.strictEqual(value.config.polluted, undefined);
        assert.strictEqual(Object.prototype.polluted, undefined);
        assert.ok(Object.prototype.hasOwnProperty.call(value.config, '__proto__'));
        assert.strictEqual(value.config.constructor, 'ordinary');
      });

      it('rejects executable YAML tags through the safe configuration API', function () {
        assert.throws(() => load('!!js/function "function () { return 1; }"'), /unknown tag/);
      });

      it('preserves ordered maps and rejects duplicate keys', function () {
        assert.deepStrictEqual(load('!!omap\n- constructor: 1\n- __proto__: 2\n'), [{ constructor: 1 }, JSON.parse('{"__proto__":2}')]);
        assert.throws(() => load('!!omap\n- repeated: 1\n- repeated: 2\n'), /cannot resolve/);
      });

      it('parses a large ordered map without quadratic CPU consumption', function () {
        this.timeout(15000);
        const script = `
          const assert = require('assert');
          const yaml = require(process.argv[1]);
          const count = 200000;
          const source = '!!omap\\n' + Array.from({length: count}, (_, i) => '- k' + i + ': ' + i).join('\\n');
          const result = yaml[process.argv[2]](source);
          assert.strictEqual(result.length, count);
          assert.strictEqual(result[count - 1]['k' + (count - 1)], count - 1);
        `;
        run('-e', [script, consumerRequire.resolve('js-yaml'), version.method], __dirname);
      });
    });
  }

  describe('tool configuration consumers', function () {
    let directory;
    beforeEach(function () {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightscout-yaml-'));
      fs.writeFileSync(path.join(directory, 'package.json'), '{}');
    });
    afterEach(function () {
      fs.rmSync(directory, { recursive: true, force: true });
    });
    function fixture(name, value) {
      const file = path.join(directory, name);
      fs.writeFileSync(file, value);
      return file;
    }

    it('loads ESLint YAML configuration and produces YAML TAP diagnostics', function () {
      const config = fixture('.eslintrc.yml', 'root: true\nrules:\n  no-undef: error\n');
      const { CLIEngine } = require('eslint');
      const eslint = new CLIEngine({ cwd: directory, useEslintrc: false, configFile: config });
      const report = eslint.executeOnText('missingName();', 'fixture.js');
      assert.strictEqual(report.errorCount, 1);
      assert.strictEqual(report.results[0].messages[0].ruleId, 'no-undef');
      const output = CLIEngine.getFormatter('tap')(report.results);
      assert.ok(output.includes('not ok 1'));
      const diagnostic = output.match(/ {2}---\n([\s\S]*?)\.\.\./)[1].replace(/^ {2}/gm, '');
      const consumerRequire = createRequire(require.resolve('eslint'));
      assert.strictEqual(consumerRequire('js-yaml').safeLoad(diagnostic).data.ruleId, 'no-undef');
    });

    it('loads nyc YAML options and preserves inherited configuration', async function () {
      fixture('base.yml', 'reporter: [lcov, text-summary]\nexclude: [tests/**]\n');
      const file = fixture('.nycrc.yml', 'extends: ./base.yml\nall: true\ncheck-coverage: true\n');
      const { loadNycConfig } = require('@istanbuljs/load-nyc-config');
      const nycConfig = await loadNycConfig({ cwd: directory, nycrcPath: file });
      assert.strictEqual(nycConfig.all, true);
      assert.strictEqual(nycConfig.checkCoverage, true);
      assert.deepStrictEqual(nycConfig.reporter, ['lcov', 'text-summary']);
      assert.deepStrictEqual(nycConfig.exclude, ['tests/**']);
    });

    it('runs Mocha using a YAML config with numeric timeouts and test globs', function () {
      this.timeout(15000);
      const config = fixture('.mocharc.yml', 'timeout: 3000\nreporter: json\nspec: ["*.test.cjs"]\n');
      fixture('fixture.test.cjs', "it('configured timeout', function () { require('assert').strictEqual(this.timeout(), 3000); });");
      const output = run(require.resolve('mocha/bin/mocha.js'), ['--no-package', '--config', config, '--exit'], directory);
      const report = JSON.parse(output);
      assert.strictEqual(report.stats.passes, 1);
      assert.strictEqual(report.stats.failures, 0);
    });
  });
});
