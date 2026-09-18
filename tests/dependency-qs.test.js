'use strict';

const assert = require('assert');
const {createRequire} = require('module');
const fromExpress = createRequire(require.resolve('express'));
const fromConnect = createRequire(require.resolve('nightscout-connect'));

describe('query parser consumer regressions', function () {
  for (const [name, qs] of [['Express', fromExpress('qs')], ['Connect', fromConnect('qs')]]) {
    it(name + ' serializes nullable comma arrays without throwing', function () {
      assert.strictEqual(qs.stringify({values: ['one', null, undefined, 'two']}, {
        arrayFormat: 'comma', encodeValuesOnly: true
      }), 'values=one,,,two');
    });

    it(name + ' preserves nested filters, unicode, plus signs and arrays', function () {
      const input = {find: {date: {$gte: '1700000000000'}, device: {$in: ['a+b', 'café']}}, count: '100'};
      assert.deepStrictEqual(qs.parse(qs.stringify(input)), input);
    });

    it(name + ' safely serializes a non-callable constructor.isBuffer', function () {
      const input = JSON.parse('{"value":{"constructor":{"isBuffer":true},"notes":"Fish & Chips"}}');
      const output = qs.stringify(input);
      assert.ok(output.includes('notes%5D=Fish%20%26%20Chips'));
      assert.strictEqual({}.isBuffer, undefined);
    });

    it(name + ' enforces explicit comma-array limits for bracket groups', function () {
      assert.throws(() => qs.parse('values[]=1,2,3', {
        comma: true, arrayLimit: 2, throwOnLimitExceeded: true
      }), RangeError);
      assert.deepStrictEqual(qs.parse('values[]=1,2', {
        comma: true, arrayLimit: 2, throwOnLimitExceeded: true
      }), {values: [['1', '2']]});
    });
  }

});
