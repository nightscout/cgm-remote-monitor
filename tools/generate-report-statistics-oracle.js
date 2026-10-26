'use strict';
// Run with an independently installed simple-statistics 0.7.0 module path.
const assert = require('node:assert/strict');
const ss = require(process.argv[2]);
assert.equal(require(require.resolve(process.argv[2] + '/package.json')).version, '0.7.0');
const probabilities = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
const cases = [[], [7], [1, 2, 3, 4], [5, 1, 3], [2, 2, 2, 2], [8.3, 2.8, 5.6, 11.1], [0, 0, 600], [-5, -1, 0, 2], [1e10, 1e10 + 1, 1e10 + 2]];
let seed = 1729;
for (let length = 1; length <= 100; length++) {
  cases.push(Array.from({length}, () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed % 6001) / 10;}));
}
console.log(JSON.stringify({source: 'simple-statistics 0.7.0', probabilities,
  cases: cases.map(values => ({values, mean: ss.mean(values), deviation: ss.standard_deviation(values), quantiles: ss.quantile(values, probabilities)}))}, null, 2));
