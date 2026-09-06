'use strict';
const assert = require('node:assert/strict');
const ss = require('simple-statistics');

describe('Report quantile contracts', function () {
  for (const values of [[], [7], [4, 1, 3, 2], [5, 1, 3], [2, 2, 2, 2], [8.3, 2.8, 5.6, 11.1]]) {
    it('retains scalar results and source values for ' + JSON.stringify(values), function () {
      const before = values.slice(), probabilities = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
      const expected = probabilities.map(p => ss.quantile(values, p));
      const batch = ss.quantile(values, probabilities);
      assert.deepEqual(batch || probabilities.map(() => null), expected);
      assert.deepEqual(values, before);
    });
  }
  it('retains the legacy quartile and population deviation definition', function () {
    assert.deepEqual(ss.quantile([4, 1, 3, 2], [0.25, 0.5, 0.75]), [1.5, 2.5, 3.5]);
    assert.ok(Math.abs(ss.standard_deviation([1, 2, 3, 4]) - Math.sqrt(1.25)) < 1e-12);
  });
  it('sorts a cloned input once for a probability array', function () {
    let sorts = 0;
    class MeasuredArray extends Array {sort(compare) {sorts++; return super.sort(compare);}}
    const values = MeasuredArray.from([4, 1, 3, 2]);
    ss.quantile(values, [0.1, 0.25, 0.5, 0.75, 0.9]);
    assert.equal(sorts, 1);
    assert.deepEqual(Array.from(values), [4, 1, 3, 2]);
    sorts = 0;
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) ss.quantile(values, p);
    assert.equal(sorts, 5);
  });
});
