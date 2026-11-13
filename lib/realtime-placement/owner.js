'use strict';

const { createHash } = require('node:crypto');
// Stable across same-assignment process restarts (legacy across all revisions).
// Contract2 changes the key only for a new assignment. Two processes cannot
// hold one configured worker's resource concurrently on the actual datastore.
// Resource loss revokes work; it never authorizes a replacement under partition.
function key ({ worker, consumer, ownershipVersion = 1, assignmentIncarnation }) {
  if (typeof worker !== 'string' || !/^[a-z][a-z0-9_-]{0,62}$/.test(worker) ||
      typeof consumer !== 'string' || !/^realtime-[A-Za-z0-9_-]{1,112}$/.test(consumer)) throw new TypeError('Worker and stable realtime consumer required');
  if (![1, 2].includes(ownershipVersion) || ownershipVersion === 1 && assignmentIncarnation !== undefined ||
      ownershipVersion === 2 && !require('../server/realtime/contract').uuid(assignmentIncarnation)) throw new TypeError('Exact realtime ownership contract required');
  const bytes = createHash('sha256').update(ownershipVersion === 1 ? 'nightscout-realtime-owner-v1\0' + consumer + '\0' + worker :
    'nightscout-realtime-owner-v2\0' + consumer + '\0' + worker + '\0' + assignmentIncarnation).digest();
  return bytes.readBigInt64BE(0).toString();
}
async function acquire ({ connection, worker, consumer, onLoss, ownershipVersion = 1, assignmentIncarnation }) {
  if (!connection || typeof connection.holdAdvisoryLock !== 'function') throw new TypeError('Actual owner connection required');
  return connection.holdAdvisoryLock(key({worker, consumer, ownershipVersion, assignmentIncarnation}), onLoss);
}
module.exports = { acquire, key };
