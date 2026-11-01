'use strict';

// Watch mode may produce extra builds. Only the build belonging to this edit
// can resolve its waiter; stale successes must not hide an expected error.
module.exports = function compiled(worker, requestId = 0, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Page HMR compiler timed out')), timeout);
    const onMessage = message => {
      if (message.requestId !== requestId) return;
      finish(message.error ? new Error(message.error) : null, message);
    };
    const onExit = code => finish(new Error('Page HMR compiler exited: ' + code));
    function finish(error, value) {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('exit', onExit);
      if (error) reject(error); else resolve(value);
    }
    worker.on('message', onMessage);
    worker.once('exit', onExit);
  });
};
