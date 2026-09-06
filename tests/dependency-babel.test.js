'use strict';

// Paths and executable code below are repository sources or local test fixtures.
/* eslint-disable security/detect-non-literal-fs-filename */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const babel = require('@babel/core');
const webpack = require('webpack');
const semver = require('semver');
const projectRoot = path.resolve(__dirname, '..');

function evaluate(code) {
  const sandbox = {module: {exports: {}}, setTimeout, clearTimeout};
  vm.runInNewContext(code, sandbox, {timeout: 3000});
  return sandbox.module.exports;
}
function transform(source) {
  return babel.transformSync(source, {filename: path.join(projectRoot, 'tests/babel-fixture.js'),
    configFile: false, babelrc: false, presets: [[require.resolve('@babel/preset-env'), {targets: {safari: '9'}}]]}).code;
}

describe('Babel compiler compatibility', function () {
  it('keeps the compiler and loader compatible with the declared Node major lines', function () {
    const compiler = require('@babel/core/package.json');
    const preset = require('@babel/preset-env/package.json');
    const loader = require('babel-loader/package.json');
    [compiler, preset, loader].forEach(pkg => {
      ['20.0.0', '22.0.0', '24.0.0'].forEach(version => assert.ok(semver.satisfies(version, pkg.engines.node), pkg.name + ' excludes Node ' + version));
    });
    assert.ok(semver.satisfies(compiler.version, preset.peerDependencies['@babel/core']));
    assert.ok(semver.satisfies(compiler.version, loader.peerDependencies['@babel/core']));
    assert.ok(semver.satisfies(require('webpack/package.json').version, loader.peerDependencies.webpack));
  });
  it('preserves lexical this, nullish zero and optional chaining on an older browser target', function () {
    const result = evaluate(transform(`
      const model = { value: 7, calculate() { return [1, 2].map(n => n + this.value); } };
      const empty = null;
      module.exports = [model.calculate(), empty?.value ?? 9, ({value: 0})?.value ?? 9];
    `));
    assert.strictEqual(JSON.stringify(result), '[[8,9],9,0]');
  });
  it('preserves object rest getters and private class state across calls', function () {
    const result = evaluate(transform(`
      let reads = 0;
      const original = { retained: 1, get value() { reads++; return 5; } };
      const {retained, ...rest} = original;
      class Counter { #value = rest.value; next() { return ++this.#value; } }
      const counter = new Counter();
      module.exports = [retained, rest.value, reads, counter.next(), counter.next()];
    `));
    assert.strictEqual(JSON.stringify(result), '[1,5,1,6,7]');
  });
  it('preserves async generator cleanup on early termination', async function () {
    const run = evaluate(transform(`
      module.exports = async function () {
        const events = [];
        async function* samples() {
          try { yield await Promise.resolve(123); yield 456; }
          finally { events.push('closed'); }
        }
        for await (const value of samples()) { events.push(value); break; }
        return events;
      };
    `));
    assert.strictEqual(JSON.stringify(await run()), '[123,"closed"]');
  });
  it('rejects invalid new-super syntax instead of emitting a broken bundle', function () {
    assert.throws(() => transform('class Invalid extends Array { method() { return new super(); } }'), /super/);
  });
});

describe('Webpack Babel loader integration', function () {
  this.timeout(15000);
  let directory, entry, cacheDirectory;
  const source = `
    import duration from ${JSON.stringify(path.join(projectRoot, 'lib/client-core/careportal/duration'))};
    import configureUnits from ${JSON.stringify(path.join(projectRoot, 'lib/units'))};
    const units = configureUnits();
    const reading = {value: 126};
    export default {minutes: duration('1.5h') / 60000,
      mmol: units.mgdlToMMOL(reading?.value ?? 0), mgdl: units.mmolToMgdl(7), marker: 'first'};
  `;
  beforeEach(function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightscout-babel-'));
    entry = path.join(directory, 'entry.js');
    cacheDirectory = path.join(directory, 'cache');
    fs.writeFileSync(entry, source);
  });
  afterEach(function () { fs.rmSync(directory, {recursive: true, force: true}); });

  async function compile(mode) {
    // Load the actual loader rule so configuration changes are exercised too.
    const rule = require('../webpack/webpack.config').module.rules.find(rule => rule.use && rule.use.loader === 'babel-loader');
    const compiler = webpack({mode, context: projectRoot, target: 'web', entry,
      devtool: 'source-map', output: {path: path.join(directory, 'output'), filename: 'bundle.js', library: {type: 'commonjs2'}},
      resolve: {modules: [path.join(projectRoot, 'node_modules'), 'node_modules']},
      module: {rules: [{...rule, use: {...rule.use, loader: require.resolve('babel-loader'), options: {...rule.use.options, cacheDirectory}}}]}});
    try {
      const stats = await new Promise((resolve, reject) => compiler.run((error, stats) => error ? reject(error) : resolve(stats)));
      assert.ok(!stats.hasErrors(), stats.toString({all: false, errors: true}));
      const code = fs.readFileSync(path.join(directory, 'output/bundle.js'), 'utf8');
      const map = JSON.parse(fs.readFileSync(path.join(directory, 'output/bundle.js.map'), 'utf8'));
      return {code, map, result: evaluate(code).default};
    } finally {
      await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
    }
  }
  ['development', 'production'].forEach(mode => {
    it('preserves actual duration/unit calculations and source maps in ' + mode, async function () {
      const built = await compile(mode);
      assert.strictEqual(JSON.stringify(built.result), '{"minutes":90,"mmol":"7.0","mgdl":126,"marker":"first"}');
      assert.ok(built.map.sources.some(name => name.includes('duration.js')));
      assert.ok(built.map.sourcesContent.some(content => content && content.includes("duration('1.5h')")));
    });
  });
  it('reuses cached output and invalidates it after two source edits', async function () {
    const initial = await compile('production');
    assert.ok(fs.readdirSync(cacheDirectory).length > 0);
    const cached = await compile('production');
    assert.strictEqual(cached.code, initial.code);
    for (const marker of ['second', 'third']) {
      fs.writeFileSync(entry, source.replace("marker: 'first'", 'marker: ' + JSON.stringify(marker)));
      const rebuilt = await compile('production');
      assert.strictEqual(rebuilt.result.marker, marker);
      assert.strictEqual(rebuilt.result.mmol, '7.0');
    }
  });
});
