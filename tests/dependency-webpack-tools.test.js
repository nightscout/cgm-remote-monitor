'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const {createRequire} = require('node:module');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');

// Exercise the installed command-line consumers, without overwriting app assets.
describe('Webpack command-line and analyzer compatibility', function () {
  this.timeout(30000);
  let directory;
  const cli = require.resolve('webpack-cli/bin/cli.js');
  const analyzer = require.resolve('webpack-bundle-analyzer/lib/bin/analyzer.js');
  function run(script, args) {
    return execFileSync(process.execPath, [script, ...args], {
      cwd: directory, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024
    });
  }
  before(function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightscout-webpack-tools-'));
    fs.writeFileSync(path.join(directory, 'entry.js'), 'console.log("Nightscout fixture 💉");');
    fs.writeFileSync(path.join(directory, 'webpack.config.cjs'),
      'module.exports = {entry: "./entry.js", output: {filename: "fixture.js"}};');
  });
  after(function () { fs.rmSync(directory, {recursive: true, force: true}); });

  for (const mode of ['production', 'development']) {
    it('builds ' + mode + ' assets and emits parseable profiling stats and reports', function () {
      const stats = run(cli, ['--mode', mode, '--config', 'webpack.config.cjs', '--profile', '--json']);
      const parsed = JSON.parse(stats);
      assert.strictEqual(parsed.errorsCount, 0);
      assert(parsed.assets.some(asset => asset.name === 'fixture.js' && asset.size > 0));
      assert(parsed.modules.some(module => module.name === './entry.js'));
      const bundle = fs.readFileSync(path.join(directory, 'dist/fixture.js'), 'utf8');
      assert(bundle.includes('Nightscout fixture'));
      fs.writeFileSync(path.join(directory, 'stats.json'), stats);
      run(analyzer, ['stats.json', 'dist', '--mode', 'json', '--report', 'report.json', '--no-open']);
      const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
      assert(report.some(asset => asset.label === 'fixture.js' && asset.parsedSize > 0 && asset.gzipSize > 0));
      run(analyzer, ['stats.json', 'dist', '--mode', 'static', '--report', 'report.html', '--no-open']);
      const html = fs.readFileSync(path.join(directory, 'report.html'), 'utf8');
      assert(html.includes('fixture.js'));
      assert(html.includes('<html'));
    });
  }
  it('loads YAML configuration through the compatible optional parser', function () {
    // CLI resolves optional parsers beside the config, so expose its actual
    // installed consumer resolution to this otherwise isolated fixture.
    const yamlPackage = createRequire(cli).resolve('js-yaml/package.json');
    fs.mkdirSync(path.join(directory, 'node_modules'));
    fs.symlinkSync(path.dirname(yamlPackage), path.join(directory, 'node_modules/js-yaml'), 'dir');
    fs.writeFileSync(path.join(directory, 'webpack.config.yaml'),
      'entry: ./entry.js\noutput:\n  filename: yaml-fixture.js\n');
    const stats = JSON.parse(run(cli, ['--mode', 'production', '--config', 'webpack.config.yaml', '--json']));
    assert.strictEqual(stats.errorsCount, 0);
    assert(stats.assets.some(asset => asset.name === 'yaml-fixture.js' && asset.size > 0));
  });
  it('returns a failure for invalid configuration instead of producing a successful build', function () {
    fs.writeFileSync(path.join(directory, 'invalid.cjs'), 'module.exports = {unknownNightscoutOption: true};');
    const result = spawnSync(process.execPath, [cli, '--config', 'invalid.cjs'], {
      cwd: directory, encoding: 'utf8', timeout: 20000
    });
    assert.ifError(result.error);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('unknownNightscoutOption'));
  });
});
