'use strict';

const {NodeCache} = require('@cacheable/node-cache');

// Notification values are boolean markers or owned, serializable receipt
// snapshots. Keep the legacy copy-on-write and expired-key extension behavior;
// the maintained cache otherwise copies only on read and can revive expired keys.
class NotificationCache extends NodeCache {
  set(key, value, ttl) {
    // Legacy reads normalize a stored undefined to null, while a miss is undefined.
    if (value === undefined) value = null;
    const snapshot = this.options.useClones && value !== null && typeof value === 'object'
      ? structuredClone(value) : value;
    return super.set(key, snapshot, ttl);
  }

  ttl(key, ttl) {
    if (!key || !this.has(key)) return false;
    if (ttl < 0) {
      this.del(key);
      return true;
    }
    // node-cache 4 treats ttl(key, 0) as a reset to the default lifetime,
    // whereas set(key, value, 0) deliberately creates a non-expiring entry.
    return super.ttl(key, ttl || this.options.stdTTL);
  }
}

module.exports = NotificationCache;
