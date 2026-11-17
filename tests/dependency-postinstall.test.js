'use strict';

// The postinstall script builds the web bundle with webpack, a devDependency.
// Run package.json's postinstall command, as npm would, in a scratch tree that
// has or lacks the build tools and an already-built bundle.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const postinstall = require('../package.json').scripts.postinstall;
const BUNDLE = 'node_modules/.cache/_ns_cache/public/js';
const ENTRIES = ['app', 'reports', 'admin', 'profile', 'food', 'clock'];
const KEY = 'node_modules/.cache/_ns_cache/randomString';

describe('npm postinstall bundle build', function () {
  this.timeout(10000);
  let root;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-postinstall-'));
    fs.mkdirSync(path.join(root, 'bin'));
    fs.mkdirSync(path.join(root, 'node_modules/.bin'), {recursive: true});
    for (const file of fs.readdirSync(path.join(repo, 'bin')).filter(name => name.endsWith('.js'))) {
      fs.copyFileSync(path.join(repo, 'bin', file), path.join(root, 'bin', file));
    }
  });
  afterEach(function () {
    fs.rmSync(root, {recursive: true, force: true});
  });

  function write (file, text) {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    fs.writeFileSync(path.join(root, file), text);
  }

  // Stand-in for webpack and webpack-cli: records its arguments and writes
  // all page entry bundles, or fails with the given status.
  function installBuildTools (status = 0) {
    write('node_modules/webpack/package.json', JSON.stringify({name: 'webpack', version: '5.0.0'}));
    write('node_modules/webpack-cli/package.json', JSON.stringify({name: 'webpack-cli', version: '4.0.0'}));
    write('node_modules/webpack-cli/bin/cli.js', `
      const fs = require('fs');
      fs.writeFileSync('webpack-args.json', JSON.stringify(process.argv.slice(2)));
      if (${status}) process.exit(${status});
      fs.mkdirSync('${BUNDLE}', {recursive: true});
      for (const name of ${JSON.stringify(ENTRIES)}) fs.writeFileSync('${BUNDLE}/bundle.' + name + '.js', 'built');
    `);
  }

  function run () {
    return spawnSync(postinstall, {
      cwd: root, shell: true, encoding: 'utf8',
      env: {...process.env, PATH: path.join(root, 'node_modules/.bin') + path.delimiter + process.env.PATH}
    });
  }

  function exists (file) {
    return fs.existsSync(path.join(root, file));
  }

  it('builds the bundle and generates the runtime key when the build tools are installed', function () {
    installBuildTools();
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'webpack-args.json'), 'utf8')),
      ['--mode', 'production', '--config', 'webpack/webpack.config.js']);
    for (const name of ENTRIES) {
      assert.equal(fs.readFileSync(path.join(root, BUNDLE, 'bundle.' + name + '.js'), 'utf8'), 'built');
    }
    assert.match(fs.readFileSync(path.join(root, KEY), 'utf8'), /^[0-9a-f]{2048}\n$/);
  });

  it('stops without generating a key when the build fails', function () {
    installBuildTools(3);
    const result = run();
    assert.equal(result.status, 3);
    assert.equal(exists(KEY), false);
  });

  it('fails with the fix named when the build tools were omitted and there is no bundle', function () {
    const result = run();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /cannot build the web page bundle/);
    assert.match(result.stderr, /npm ci --include=dev/);
    assert.equal(exists(BUNDLE), false);
    assert.equal(exists(KEY), false);
  });

  it('keeps an already-built bundle when the build tools were omitted', function () {
    for (const name of ENTRIES) write(BUNDLE + '/bundle.' + name + '.js', 'prebuilt');
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /bundle was not rebuilt/);
    for (const name of ENTRIES) {
      assert.equal(fs.readFileSync(path.join(root, BUNDLE, 'bundle.' + name + '.js'), 'utf8'), 'prebuilt');
    }
    assert.match(fs.readFileSync(path.join(root, KEY), 'utf8'), /^[0-9a-f]{2048}\n$/);
  });

  for (const missing of ENTRIES) {
    it('rejects a prebuilt installation missing the ' + missing + ' bundle', function () {
      for (const name of ENTRIES.filter(name => name !== missing)) {
        write(BUNDLE + '/bundle.' + name + '.js', 'prebuilt');
      }
      const result = run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /cannot build the web page bundle/);
      assert.match(result.stderr, /npm ci --include=dev/);
      assert.equal(exists(KEY), false);
    });
  }
});
