'use strict';

const assert = require('node:assert/strict');
const {createRequire} = require('node:module');

// Exercise the validators resolved by the actual build-tool consumers.
describe('Ajv 8 format lookup boundary', function () {
  for (const consumer of ['schema-utils', 'ajv-formats']) {
    it(consumer + ' rejects inherited format names and preserves registered formats', function () {
      const Ajv = createRequire(require.resolve(consumer))('ajv');
      const ajv = new Ajv({$data: true});
      ajv.addFormat('fixture-code', /^[A-Z]{3}$/);
      const validate = ajv.compile({
        type: 'object',
        required: ['value', 'formatName'],
        properties: {
          value: {type: 'string', format: {$data: '1/formatName'}},
          formatName: {type: 'string'}
        }
      });
      for (const formatName of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        assert.equal(validate({value: 'ABC', formatName}), false, formatName);
        assert.equal(validate.errors[0].keyword, 'format');
      }
      assert.equal(validate({value: 'ABC', formatName: 'fixture-code'}), true);
      assert.equal(validate({value: 'abc', formatName: 'fixture-code'}), false);
    });
  }
});
