'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {ESLint} = require('eslint');
const root = path.resolve(__dirname, '..');

describe('maintained ESLint configuration', function () {
  it('loads the repository config and reports core errors and security warnings across repeated lint calls', async function () {
    const lint = new ESLint({cwd: root});
    for (let cycle = 0; cycle < 2; cycle++) {
      const [result] = await lint.lintText("var unused = 1; require('fs').readFileSync(process.argv[2]);", {filePath: path.join(root, 'lib/owned-lint-fixture.js')});
      assert.ok(result.messages.some(item => item.ruleId === 'no-unused-vars' && item.severity === 2));
      assert.ok(result.messages.some(item => item.ruleId === 'security/detect-non-literal-fs-filename' && item.severity === 1));
      const formatter = await lint.loadFormatter('stylish');
      assert.match(await formatter.format([result]), /no-unused-vars/);
    }
  });

  it('retains browser, Node, test and jQuery globals without disabling undefined-name diagnostics', async function () {
    const lint = new ESLint({cwd: root});
    const filePath = path.join(root, 'lib/owned-lint-fixture.js');
    const [valid] = await lint.lintText("module.exports = function () { describe('owned', function () { window.console.log($('body').length, Buffer.from('x').length); }); };", {filePath});
    assert.deepEqual(valid.messages, []);
    const [invalid] = await lint.lintText('unknownOwnedVariable();', {filePath});
    assert.ok(invalid.messages.some(item => item.ruleId === 'no-undef' && item.severity === 2));
  });

  it('retains the explicit object-injection exception and current unused-variable name policy', async function () {
    const lint = new ESLint({cwd: root});
    const [result] = await lint.lintText('var should = 1; module.exports = function (object, key) { return object[key]; };', {filePath: path.join(root, 'lib/client/owned-lint-fixture.js')});
    assert.deepEqual(result.messages, []);
  });
});
