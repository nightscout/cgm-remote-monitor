'use strict';
// A refused bootstrap may never enter its callback. Observe its outcome while
// waiting for the requested phase so a native fixture cannot hang on that phase.
module.exports = function snapshotRecoveryEntry (entered, pending) {
  return Promise.race([entered, pending.then(() => { throw new Error('SNAPSHOT_CALLBACK_NOT_ENTERED'); })]);
};
