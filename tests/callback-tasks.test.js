'use strict';

const assert = require('node:assert/strict');
const tasks = require('../lib/utils/callback-tasks');
const implementations = [['native', tasks]];
if (process.env.NIGHTSCOUT_ASYNC_ORACLE) implementations.unshift(['legacy', require(process.env.NIGHTSCOUT_ASYNC_ORACLE)]);

for (const [name, api] of implementations) {
  describe(name + ' callback task contracts', function () {
    it('starts at most ten handlers and returns results in input order', function () {
      const waiting = [], started = [];
      let result, calls = 0;
      api.parallelLimit(Array.from({length: 12}, (_, i) => next => {started.push(i); waiting[i] = next;}), 10, (err, values) => {
        assert.ifError(err); calls++; result = values;
      });
      assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      waiting[9](null, 9); waiting[8](null, 8);
      assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      for (const i of [11, 10, 7, 6, 5, 4, 3, 2, 1, 0]) waiting[i](null, i);
      assert.equal(calls, 1); assert.deepEqual(result, Array.from({length: 12}, (_, i) => i));
    });
    it('does not advance serial tasks until their callbacks finish', function () {
      const started = [], waiting = [];
      let result;
      api.series([0, 1, 2].map(i => next => {started.push(i); waiting.push(next);}), (err, values) => {assert.ifError(err); result = values;});
      assert.deepEqual(started, [0]); waiting[0](null, 'a');
      assert.deepEqual(started, [0, 1]); waiting[1](null, 'b');
      assert.deepEqual(started, [0, 1, 2]); waiting[2](null, 'c');
      assert.deepEqual(result, ['a', 'b', 'c']);
    });
    it('stops sequential writes at the first error', function () {
      const started = [], failure = new Error('Owned failure');
      let result, calls = 0;
      api.eachSeries([0, 1, 2], (item, next) => {started.push(item); next(item === 1 ? failure : null);}, err => {result = err; calls++;});
      assert.deepEqual(started, [0, 1]); assert.equal(result, failure); assert.equal(calls, 1);
    });
    it('preserves synchronous completion and multiple callback values', function () {
      const order = [];
      api.parallel([next => next(null, 1, 2), next => next(null, 3)], (err, values) => {
        assert.ifError(err); assert.deepEqual(values, [[1, 2], 3]); order.push('done');
      });
      order.push('returned'); assert.deepEqual(order, ['done', 'returned']);
    });
    it('completes empty inputs immediately', function () {
      let calls = 0;
      api.parallel([], (err, values) => {assert.ifError(err); assert.deepEqual(values, []); calls++;});
      api.eachSeries([], () => assert.fail('No item exists'), err => {assert.ifError(err); calls++;});
      assert.equal(calls, 2);
    });
  });
}

describe('Native callback task safeguards', function () {
  it('handles 10,000 synchronously completed sequential writes without recursion', function () {
    let completed = 0;
    tasks.eachSeries(Array.from({length: 10000}, (_, i) => i), (item, next) => {assert.equal(item, completed++); next();}, assert.ifError);
    assert.equal(completed, 10000);
  });
  it('does not start pending work or call completion again after a bounded task fails', function () {
    const waiting = [], started = [];
    let calls = 0, result;
    tasks.parallelLimit([0, 1, 2].map(i => next => {started.push(i); waiting.push(next);}), 2, (err, values) => {
      assert.equal(err.message, 'Owned failure'); calls++; result = values.slice();
    });
    waiting[0](new Error('Owned failure')); waiting[1](null, 'late');
    assert.equal(calls, 1); assert.deepEqual(started, [0, 1]); assert.deepEqual(result, [undefined]);
  });
  it('rejects a duplicate callback instead of running another task twice', function () {
    tasks.series([next => {next(); assert.throws(() => next(), /already called/);}], assert.ifError);
  });
});
