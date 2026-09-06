'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const webpack = require('webpack');
const DevelopmentLintPlugin = require('../webpack/lint-plugin');

describe('development lint diagnostics', function () {
  it('reports fresh lint findings without blocking builds and keeps syntax failures fatal', async function () {
    this.timeout(15000);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightscout-lint-'));
    const entry = path.join(directory, 'entry.js');
    fs.writeFileSync(path.join(directory, 'eslint.config.cjs'), "module.exports = [{rules: {'no-unused-vars': 'error', 'no-undef': 'error'}}];");
    const compiler = webpack({mode: 'development', context: directory, entry, cache: false,
      devtool: false, output: {path: path.join(directory, 'output')},
      plugins: [new DevelopmentLintPlugin()]});
    async function build(source) {
      fs.writeFileSync(entry, source);
      return new Promise((resolve, reject) => compiler.run((error, stats) => error ? reject(error) : resolve(stats)));
    }
    try {
      for (const name of ['unusedFirst', 'unusedSecond']) {
        const stats = await build('var ' + name + ' = 1;');
        assert.equal(stats.hasErrors(), false);
        assert.equal(stats.hasWarnings(), true);
        const warnings = stats.toJson({all: false, warnings: true}).warnings;
        assert.equal(warnings.length, 1);
        assert.match(warnings[0].message, new RegExp(name));
        assert.match(warnings[0].message, /no-unused-vars/);
        if (name === 'unusedSecond') assert.doesNotMatch(warnings[0].message, /unusedFirst/);
      }
      const invalid = await build('const ownedBroken = ;');
      assert.equal(invalid.hasErrors(), true);
      const clean = await build('export const used = 1;');
      assert.equal(clean.hasErrors(), false);
      assert.equal(clean.hasWarnings(), false);
    } finally {
      await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });
});
