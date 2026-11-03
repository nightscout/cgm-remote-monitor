'use strict';

const assert = require('assert');
const {createRequire} = require('module');
const fromESLint = createRequire(require.resolve('eslint'));

describe('AJV 6 consumer compatibility', function () {
  it('keeps ESLint rule option validation and lint diagnostics', async function () {
    const {ESLint} = require('eslint');
    const engine = new ESLint({overrideConfigFile: true, overrideConfig: {rules: {'no-unused-vars': 'error'}}});
    const [result] = await engine.lintText('var unused = 1;');
    assert.strictEqual(result.errorCount, 1);
    assert.strictEqual(result.messages[0].ruleId, 'no-unused-vars');
    await assert.rejects(() => new ESLint({overrideConfigFile: true, overrideConfig: {rules: {'no-unused-vars': ['error', {vars: 'invalid'}]}}})
      .lintText('var unused = 1;'), /no-unused-vars|Configuration for rule/);
  });

  it('returns a validation failure for malformed dynamic patterns instead of throwing', function () {
    const Ajv = fromESLint('ajv');
    const validate = new Ajv({$data: true}).compile({type: 'object', properties: {
      pattern: {type: 'string'}, value: {type: 'string', pattern: {$data: '1/pattern'}}
    }});
    assert.strictEqual(validate({pattern: '^ok$', value: 'ok'}), true);
    assert.strictEqual(validate({pattern: '[', value: 'ok'}), false);
    assert.strictEqual(validate.errors[0].keyword, 'pattern');
  });
});
