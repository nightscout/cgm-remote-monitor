'use strict';

const assert = require('assert');
const {createRequire} = require('module');
const fromExpress = createRequire(require.resolve('express'));

// request, the other qs consumer this file covered, was removed with the
// legacy Dexcom and MiniMed bridges; Express is the consumer left.
describe('query parser consumer regressions', function () {
  for (const [name, qs] of [['Express', fromExpress('qs')]]) {
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
