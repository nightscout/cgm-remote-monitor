'use strict';

// Fixtures live in a fresh temporary directory and contain only static test code.
/* eslint-disable security/detect-non-literal-fs-filename */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

describe('Mocha runner compatibility', function () {
  this.timeout(15000);
  let directory;
  const mocha = require.resolve('mocha/bin/mocha.js');

  beforeEach(function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightscout-mocha-'));
  });

  afterEach(function () {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function fixture(name, source) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, source);
    return file;
  }

  function run(args, reporter = 'json') {
    // Do not pass MongoDB settings or the parent nyc instrumentation to fixtures.
    const env = { NODE_ENV: 'test' };
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const result = spawnSync(process.execPath, [
      mocha, '--no-config', '--no-package', '--timeout', '2000', '--exit',
      '--reporter', reporter, ...args
    ], { cwd: directory, env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.strictEqual(result.signal, null, result.stderr);
    return { ...result, report: reporter === 'json' ? JSON.parse(result.stdout) : null };
  }

  for (const parallel of [false, true]) {
    it('loads CommonJS root hooks and callback/async tests in ' + (parallel ? 'parallel' : 'serial') + ' mode', function () {
      const hooks = fixture('hooks.cjs', `
        const assert = require('assert');
        exports.mochaHooks = {
          beforeEach() { this.fixtureReady = true; },
          afterEach() { assert.strictEqual(this.fixtureChecked, true); }
        };
      `);
      fixture('callback.test.cjs', `
        const assert = require('assert');
        it('callback fixture', function (done) {
          assert.strictEqual(this.fixtureReady, true);
          this.fixtureChecked = true;
          setImmediate(done);
        });
      `);
      fixture('async.test.cjs', `
        const assert = require('assert');
        it('async fixture', async function () {
          assert.strictEqual(this.fixtureReady, true);
          await Promise.resolve();
          this.fixtureChecked = true;
        });
      `);
      const args = ['--require', hooks, path.join(directory, '*.test.cjs')];
      if (parallel) args.push('--parallel', '--jobs', '2');
      const result = run(args);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.strictEqual(result.report.stats.passes, 2);
      assert.strictEqual(result.report.stats.failures, 0);
      assert.strictEqual(result.report.stats.pending, 0);
      assert.deepStrictEqual(result.report.tests.map(test => test.title).sort(), ['async fixture', 'callback fixture']);
    });
  }

  it('honors fluent suite timeouts without changing test discovery', function () {
    const file = fixture('timeout.test.cjs', `
      const assert = require('assert');
      describe('suite timeout', function () {
        it('inherits the suite timeout', function () {
          assert.strictEqual(this.timeout(), 3000);
        });
      }).timeout(3000);
    `);
    const result = run([file]);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.strictEqual(result.report.stats.passes, 1);
  });

  for (const parallel of [false, true]) {
    it('reports assertion failures and exits unsuccessfully in ' + (parallel ? 'parallel' : 'serial') + ' mode', function () {
      const file = fixture('failure.test.cjs', `
        const assert = require('assert');
        it('intentional failure', function () {
          assert.strictEqual('actual-value', 'expected-value');
        });
      `);
      const args = [file];
      if (parallel) args.push('--parallel', '--jobs', '2');
      const result = run(args);
      assert.strictEqual(result.status, 1, result.stdout + result.stderr);
      assert.strictEqual(result.report.stats.failures, 1);
      assert.strictEqual(result.report.stats.passes, 0);
      assert.strictEqual(result.report.failures[0].err.actual, 'actual-value');
      assert.strictEqual(result.report.failures[0].err.expected, 'expected-value');
    });
  }

  it('renders assertion diffs with the overridden diff dependency', function () {
    const file = fixture('diff.test.cjs', `
      const assert = require('assert');
      it('intentional diff', function () { assert.strictEqual('actual-value', 'expected-value'); });
    `);
    const result = run(['--no-color', file], 'spec');
    assert.strictEqual(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stdout.includes('-actual-value'), result.stdout);
    assert.ok(result.stdout.includes('+expected-value'), result.stdout);
  });

  it('fails the process when setup fails without running affected tests', function () {
    const file = fixture('setup.test.cjs', `
      describe('setup failure', function () {
        before(function () { throw new Error('fixture setup failed'); });
        it('must not run', function () { throw new Error('affected test ran'); });
      });
    `);
    const result = run([file]);
    assert.strictEqual(result.status, 1, result.stdout + result.stderr);
    assert.strictEqual(result.report.stats.failures, 1);
    assert.strictEqual(result.report.stats.passes, 0);
    assert.strictEqual(result.report.failures[0].err.message, 'fixture setup failed');
    assert.ok(!result.stdout.includes('affected test ran'));
  });

  it('fails timed-out asynchronous tests instead of returning success', function () {
    const file = fixture('hang.test.cjs', `
      it('unfinished callback', function (done) {});
    `);
    const result = run(['--timeout', '100', file]);
    assert.strictEqual(result.status, 1, result.stdout + result.stderr);
    assert.strictEqual(result.report.stats.failures, 1);
    assert.ok(result.report.failures[0].err.message.includes('Timeout of 100ms exceeded'));
  });
});
