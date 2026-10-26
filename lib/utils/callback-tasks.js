'use strict';

// The callback-based storage/plugin interfaces need ordered results and bounded
// work, not a Promise wrapper for every callback. Only array inputs are used.
function run(items, limit, iterator, callback, collect) {
  if (!(limit > 0)) throw new RangeError('Task concurrency must be positive');
  const results = [];
  let cursor = 0, running = 0, completed = 0, stopped = false, pumping = false;
  callback = callback || function () {};
  function finish(error) {
    if (stopped) return;
    stopped = true;
    if (collect) callback(error, results);
    else callback(error);
  }
  function pump() {
    if (pumping || stopped) return;
    pumping = true;
    try {
      while (!stopped && cursor < items.length && running < limit) {
        const index = cursor++;
        running++;
        let called = false;
        iterator(items[index], function (error, ...values) {
          if (called) throw new Error('Callback was already called.');
          called = true;
          running--;
          if (stopped) return;
          if (collect) results[index] = values.length > 1 ? values : values[0];
          completed++;
          if (error) finish(error);
          else if (completed === items.length) finish();
          else pump();
        });
      }
    } finally {pumping = false;}
  }
  if (!items.length) finish();
  else pump();
}

function parallelLimit(tasks, limit, callback) {
  return run(tasks, limit, (task, next) => task(next), callback, true);
}
module.exports = {
  parallelLimit,
  parallel: (tasks, callback) => parallelLimit(tasks, Math.max(tasks.length, 1), callback),
  series: (tasks, callback) => parallelLimit(tasks, 1, callback),
  eachSeries: (items, iterator, callback) => run(items, 1, iterator, callback, false)
};
