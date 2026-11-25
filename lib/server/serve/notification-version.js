'use strict';

// Version-only read for the notification producer's "unchanged?" checks
// (lib/tenant-notifications/producer.js). Those checks compare identity,
// runtimeId, outputRevision, inputCheckpoint, contentDigest and eligibility, so
// an eligible runtime observation (`peek`) answers them without loading an
// evicted full output. Anything else falls through to `output`, the same read
// the selection used: an ineligible runtime returns null there without a load,
// and the cold-start recovery path (runtime still starting, no observation)
// keeps its durable read, so a newer stored revision is still noticed.
module.exports = function notificationVersion ({ peek, output }) {
  if (typeof peek !== 'function' || typeof output !== 'function') throw new TypeError('Notification version reader requires peek and output');
  return async tenant => {
    const seen = peek(tenant);
    return seen?.eligible === true ? seen : output(tenant);
  };
};
