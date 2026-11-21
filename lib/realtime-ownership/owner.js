'use strict';
const {createHash} = require('node:crypto');
const {parse} = require('./index');
const fail = () => { throw Object.assign(new Error('REALTIME_MIXED_LAYOUT_REFUSED'), {code: 'REALTIME_MIXED_LAYOUT_REFUSED'}); };
function keys(consumer, shape) {
  parse(shape);
  if (typeof consumer !== 'string' || !/^realtime-[A-Za-z0-9_-]{1,112}$/.test(consumer)) throw new TypeError('Stable realtime consumer required');
  const hash = text => createHash('sha256').update(text).digest();
  const prefix = hash('realtime-static-layout-v1\0' + consumer).readUInt32BE(0);
  const marker = BigInt.asIntN(64, (BigInt(prefix) << 32n) | BigInt(shape.count)).toString();
  // Ordinal key deliberately excludes K, so an overlapping ordinal refuses
  // even before the mixed-layout check, across coordinated resize attempts.
  const owner = hash('realtime-static-owner-v1\0' + consumer + '\0' + shape.ordinal).readBigInt64BE(0).toString();
  return {owner, marker, prefix};
}
async function acquire({connection, observer = connection, consumer, shape, onLoss}) {
  const {owner, marker, prefix} = keys(consumer, shape);
  const resource = await connection.holdAdvisoryLock(owner, onLoss, {sharedKey: marker});
  try {
    // The marker is held BEFORE observation. Concurrent differing layouts see
    // each other, or the later admission sees the already admitted layout.
    // Only refusal follows; this observation never authorizes a takeover.
    const rows = (await observer.readOnly("SELECT objid::text AS count FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=$1::oid AND objsubid=1 AND granted", [String(prefix)])).rows;
    if (!rows.length || rows.some(row => row.count !== String(shape.count))) fail();
    await resource.check();
    return resource;
  } catch (error) { await resource.close(); throw error; }
}
module.exports = {keys, acquire};
