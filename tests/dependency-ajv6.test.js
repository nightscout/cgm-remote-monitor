'use strict';

const assert = require('assert');
const {createRequire} = require('module');
const fromESLint = createRequire(require.resolve('eslint'));
const fromPlugin = createRequire(require.resolve('eslint-webpack-plugin'));

describe('AJV 6 consumer compatibility', function () {
  it('keeps ESLint rule option validation and lint diagnostics', function () {
    const {CLIEngine} = require('eslint');
    const engine = new CLIEngine({useEslintrc: false, rules: {'no-unused-vars': 'error'}});
    const result = engine.executeOnText('var unused = 1;');
    assert.strictEqual(result.errorCount, 1);
    assert.strictEqual(result.results[0].messages[0].ruleId, 'no-unused-vars');
    assert.throws(() => new CLIEngine({useEslintrc: false, rules: {'no-unused-vars': ['error', {vars: 'invalid'}]}})
      .executeOnText('var unused = 1;'), /Configuration for rule/);
  });

  it('preserves the webpack lint plugin schema validation including absolutePath', function () {
    const {validate} = fromPlugin('schema-utils');
    const schema = {type: 'object', properties: {directory: {type: 'string', absolutePath: true}},
      required: ['directory'], additionalProperties: false};
    validate(schema, {directory: '/tmp/nightscout-schema-fixture'});
    assert.throws(() => validate(schema, {directory: 'relative'}), /absolute path/);
    assert.throws(() => validate(schema, {directory: '/tmp', extra: true}), /unknown property/);
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
