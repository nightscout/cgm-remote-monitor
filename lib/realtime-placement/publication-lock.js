'use strict';
const { createHash } = require('node:crypto');
function key (namespace) {
  if (typeof namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || ['public', 'information_schema'].includes(namespace) || namespace.startsWith('pg_')) throw new TypeError('Explicit placement control namespace required');
  return createHash('sha256').update('nightscout-realtime-placement-publication-v1\0' + namespace).digest().readBigInt64BE(0).toString();
}
async function pin (client, namespace) {
  if (!client || typeof client.query !== 'function') throw new TypeError('Actual dedicated maintenance client required');
  const resource = key(namespace);
  const row = (await client.query('SELECT pg_try_advisory_lock_shared($1::bigint) AS held', [resource])).rows[0];
  if (row?.held !== true) throw Object.assign(new Error('RESTORE_COHORT_PLACEMENT_BUSY'), { code: 'RESTORE_COHORT_PLACEMENT_BUSY' });
  let closed = false;
  return Object.freeze({ async close () {
    if (closed) return;
    const released = (await client.query('SELECT pg_advisory_unlock_shared($1::bigint) AS released', [resource])).rows[0];
    if (released?.released !== true) throw Object.assign(new Error('RESTORE_COHORT_PLACEMENT_LOCK_LOST'), { code: 'RESTORE_COHORT_PLACEMENT_LOCK_LOST' });
    closed = true;
  } });
}
module.exports = { key, pin };
