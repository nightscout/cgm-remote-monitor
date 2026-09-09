'use strict';
const assert = require('node:assert/strict');
const ss = require('../lib/report/statistics');
const oracle = require('./fixtures/report-statistics-oracle.json');

describe('Local report statistics against recorded 0.7.0 results', function () {
  for (const [index, sample] of oracle.cases.entries()) {
    it('retains exact numeric results and immutable inputs for sample ' + index, function () {
      const values = Object.freeze(sample.values.slice());
      assert.equal(ss.mean(values), sample.mean);
      assert.equal(ss.standard_deviation(values), sample.deviation);
      assert.deepEqual(ss.quantile(values, oracle.probabilities), sample.quantiles);
      for (const [i, p] of oracle.probabilities.entries()) assert.equal(ss.quantile(values, p), sample.quantiles ? sample.quantiles[i] : null);
      assert.deepEqual(values, sample.values);
    });
  }
  it('keeps empty, invalid-probability and nonfinite behavior', function () {
    assert.equal(ss.mean([]), null);
    assert.equal(ss.standard_deviation([]), null);
    assert.equal(ss.quantile([], [0.5]), null);
    assert.deepEqual(ss.quantile([1, 2, 3], [-1, 2]), [null, null]);
    assert.equal(ss.quantile([1, 2, 3], NaN), undefined);
    assert.ok(Number.isNaN(ss.mean([1, NaN])));
    assert.ok(Number.isNaN(ss.standard_deviation([1, Infinity])));
  });
});
