'use strict';

function runWithCallback (work, callback) {
  const promise = Promise.resolve().then(work);

  if (callback && callback.call) {
    promise.then(
      function onSuccess(result) {
        callback(null, result);
      },
      function onError(err) {
        callback(err, null);
      }
    );
  }

  return promise;
}

module.exports = runWithCallback;
