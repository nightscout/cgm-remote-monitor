'use strict';

// Boot stages report recoverable failures through ctx.bootErrors. Their next
// callback advances the same context; fatal synchronous errors still escape.
module.exports = function bootSequence(stages) {
  const context = {};
  const pending = stages.slice();
  let cursor = 0;
  function next() {
    const stage = pending[cursor++];
    if (!stage) return;
    let advanced = false;
    stage(context, function advance() {
      if (advanced) throw new Error('Boot stage callback was already called.');
      advanced = true;
      next();
    });
  }
  // Match bootevent: queue construction finishes before the first stage runs.
  process.nextTick(next);
  const sequence = {
    boot(callback) {
      pending.push(context => {if (callback) callback(context);});
      return sequence;
    }
  };
  return sequence;
};
