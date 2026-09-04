'use strict';

const ALARM_COLLECTION = 'alarmsnooze';

function init (ctx) {

  function getCollection () {
    if (!ctx || !ctx.store || typeof ctx.store.collection !== 'function') return null;
    return ctx.store.collection(ALARM_COLLECTION);
  }

  function makeKey (level, group) {
    return level + '-' + (group || 'default');
  }

  return {
    getSnooze: async function getSnooze (level, group) {
      const coll = getCollection();
      if (!coll) return null;
      // Filter expiresAt > now to ignore TTL-lag stale docs
      return await coll.findOne({ _id: makeKey(level, group), expiresAt: { $gt: new Date() } });
    },
    setSnooze: async function setSnooze (level, group, lastAckTime, silenceTime) {
      const coll = getCollection();
      if (!coll) return null;
      const normalizedGroup = group || 'default';
      const newExpiresAt = new Date(lastAckTime + silenceTime);
      // Aggregation-pipeline $set with $cond: only overwrite when new expiresAt
      // is later than the existing one (or when no doc exists yet, via $ifNull).
      // This prevents a shorter snooze from clobbering a longer one across instances.
      const winner = { $gt: [newExpiresAt, { $ifNull: ['$expiresAt', new Date(0)] }] };
      return await coll.updateOne(
        { _id: makeKey(level, normalizedGroup) },
        [{
          $set: {
            level: level,
            group: normalizedGroup,
            lastAckTime: { $cond: [winner, lastAckTime, '$lastAckTime'] },
            silenceTime: { $cond: [winner, silenceTime, '$silenceTime'] },
            expiresAt:   { $cond: [winner, newExpiresAt, '$expiresAt'] }
          }
        }],
        { upsert: true }
      );
    },
    ensureIndexes: async function ensureIndexes () {
      const coll = getCollection();
      if (!coll) return null;
      return await coll.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    }
  };
}

module.exports = init;
