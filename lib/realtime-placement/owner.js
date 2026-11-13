'use strict';

const { createHash } = require('node:crypto');
// Stable across boot incarnations and placement revisions. Two processes cannot
// hold one configured worker's resource concurrently on the actual datastore.
// Resource loss revokes work; it never authorizes a replacement under partition.
async function acquire ({ connection, worker, consumer, onLoss }) {
  if (!connection || typeof connection.holdAdvisoryLock !== 'function' || typeof worker !== 'string' || !/^[a-z][a-z0-9_-]{0,62}$/.test(worker) ||
      typeof consumer !== 'string' || !/^realtime-[A-Za-z0-9_-]{1,112}$/.test(consumer)) throw new TypeError('Actual connection, worker and stable realtime consumer required');
  const bytes = createHash('sha256').update('nightscout-realtime-owner-v1\0' + consumer + '\0' + worker).digest();
  return connection.holdAdvisoryLock(bytes.readBigInt64BE(0).toString(), onLoss);
}
module.exports = { acquire };
