'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {referencesOf, repoFiles, reverseGraph} = require('../scripts/test-select');
const tiers = require('../scripts/test-tiers');

describe('Cut 2 test-selection graph', function () {
  const known = new Set(repoFiles());

  it('connects built-bundle tests to every page entry', function () {
    const refs = referencesOf('tests/browser/bundle.test.js', known);
    for (const entry of ['bundle.source', 'bundle.clocks.source', 'bundle.reports.source',
      'bundle.admin.source', 'bundle.profile.source', 'bundle.food.source']) {
      assert.ok(refs.has('bundle/' + entry + '.js'), 'Missing entry: ' + entry);
    }
  });

  it('keeps the narrowed D3 module connected to its browser consumer', function () {
    const refs = referencesOf('lib/client/index.js', known);
    assert.ok(refs.has('lib/d3.mjs'));
    const graph = reverseGraph(['lib/d3.mjs', 'lib/client/index.js']);
    assert.ok(graph.get('lib/d3.mjs').has('lib/client/index.js'));
  });

  it('finds a report change through its dedicated entry and a built-bundle test', function () {
    const graph = reverseGraph(repoFiles());
    const pending = ['lib/report/reportclient.js'], reached = new Set(pending);
    while (pending.length) {
      for (const file of graph.get(pending.shift()) || []) {
        if (!reached.has(file)) {reached.add(file); pending.push(file);}
      }
    }
    assert.ok(reached.has('bundle/bundle.reports.source.js'));
    assert.ok(reached.has('tests/browser/bundle.test.js'));
  });
});

describe('Test selection CLI validation', function () {
  this.timeout(15000);
  const root = path.resolve(__dirname, '..');
  const coreFile = 'tests/client-core/careportal-duration.test.js';
  const missing = 'tests/does-not-exist.test.js';
  function cli(script, args, input) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
      cwd: root, encoding: 'utf8', input, timeout: 5000
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
  }

  for (const [name, script, args, expected, input] of [
    ['unknown tier', 'test-tiers.js', ['run', 'unti'], /unknown test tier.*unti/],
    ['mixed valid and unknown tiers', 'test-tiers.js', ['run', 'core,unti', coreFile], /unknown test tier.*unti/],
    ['missing explicit file', 'test-tiers.js', ['run', 'core', missing], /unknown test file/],
    ['mixed valid and missing files', 'test-tiers.js', ['run', 'core', coreFile, missing], /unknown test file/],
    ['file outside requested tiers', 'test-tiers.js', ['run', 'unit', coreFile], /belongs to tier core/],
    ['unknown list tier', 'test-tiers.js', ['list', 'unti'], /unknown test tier/],
    ['unknown sample tier', 'test-select.js', ['sample', '12', '--tier', 'unit,missing-tier', '--run'], /unknown test tier.*missing-tier/],
    ['partially invalid selection', 'test-select.js', ['run', coreFile, missing], /unknown test file/],
    ['invalid stdin selection', 'test-select.js', ['run', '-'], /unknown test file/, missing + '\n'],
    ['explicit run without files', 'test-select.js', ['run'], /specify test files/]
  ]) {
    it('rejects ' + name + ' before running any tests', function () {
      const result = cli(script, args, input);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.doesNotMatch(result.stdout + result.stderr, /# core:|# unit:|passing/);
    });
  }

  for (const [script, args] of [
    ['test-tiers.js', ['run', 'core', coreFile]],
    ['test-select.js', ['run', '-']]
  ]) {
    it('still executes a valid explicit selection through ' + script, function () {
      const result = cli(script, args, coreFile + '\n');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /# core: 1 test files/);
      assert.match(result.stdout, /client-core\/careportal\/duration/);
      assert.match(result.stdout, /passing/);
    });
  }

  it('keeps empty automatic selections and stdin pipelines successful', function () {
    for (const [args, input] of [
      [['affected', '--files', '.gitignore', '--run'], undefined],
      [['run', '-'], '']
    ]) {
      const result = cli('test-select.js', args, input);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /no tests selected/);
      assert.doesNotMatch(result.stdout, /passing/);
    }
  });

  it('retains deterministic sampling within valid tiers', function () {
    const args = ['sample', '3', '--tier', 'core', '--seed', '8839'];
    const first = cli('test-select.js', args);
    const replay = cli('test-select.js', args);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(first.stdout, replay.stdout);
    const selected = first.stdout.trim().split('\n');
    assert.equal(selected.length, 3);
    assert.equal(new Set(selected).size, 3);
    assert.ok(selected.every(file => tiers.tierOf(file) === 'core'));
  });
});
