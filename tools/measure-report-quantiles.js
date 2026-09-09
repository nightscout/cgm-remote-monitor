'use strict';
const {performance} = require('node:perf_hooks');
const assert = require('node:assert/strict');
const ss = require('../lib/report/statistics');
const probabilities = [0.1, 0.25, 0.5, 0.75, 0.9];
const bins = Array.from({length: 48}, (_, bin) => Array.from({length: 180}, (_, i) => 40 + ((bin * 73 + i * 37) % 300)));
function measure(batched, repetitions) {
  let checksum = 0;
  const start = performance.now();
  for (let repeat = 0; repeat < repetitions; repeat++) for (const bin of bins) {
    const values = batched ? ss.quantile(bin, probabilities) : probabilities.map(p => ss.quantile(bin, p));
    for (const value of values) checksum += value;
  }
  return {milliseconds: performance.now() - start, checksum};
}
measure(false, 20); measure(true, 20);
const samples = [];
for (let pair = 0; pair < 7; pair++) {
  const result = {pair};
  for (const batched of (pair % 2 ? [true, false] : [false, true])) result[batched ? 'batched' : 'scalar'] = measure(batched, 100);
  assert.equal(result.scalar.checksum, result.batched.checksum);
  samples.push(result);
}
console.log(JSON.stringify({node: process.version, platform: process.platform, arch: process.arch,
  statistics: 'local report statistics (legacy 0.7 quantiles)', bins: bins.length, readingsPerBin: bins[0].length,
  repetitions: 100, probabilities, samples,
  scope: 'Quantile computation only; not full report rendering or retained memory'}, null, 2));
