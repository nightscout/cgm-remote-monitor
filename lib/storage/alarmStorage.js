'use strict';

const writeStep = require('./write-step');

const DEFAULT_ALARM_COLLECTION = 'alarmsnooze';

function init (ctx, env) {
  // Sites that share one database must not share snooze state, so the name
  // follows the other MONGO_*_COLLECTION settings.
  const collectionName = (env && env.alarmsnooze_collection) || DEFAULT_ALARM_COLLECTION;

  function getCollection () {
    if (!ctx || !ctx.store || typeof ctx.store.collection !== 'function') return null;
    // Writes cross the same boundary as the other storage adapters.
    return writeStep.collection(ctx.store.collection(collectionName), {name: 'alarmsnooze',
      source: 'v1/internal', bus: ctx.bus, env: env});
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
            // $literal keeps a group such as "$field" from being read as an expression.
            group: { $literal: normalizedGroup },
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

// Sites that share a database give each collection its own name. If any of those
// names was changed but the snooze collection kept its default, another site on
// the same database would share this site's snoozes.
init.hasSharedNameHazard = function hasSharedNameHazard (env) {
  if (!env || env.alarmsnooze_collection !== DEFAULT_ALARM_COLLECTION) return false;
  return ['entries', 'treatments', 'profile', 'devicestatus']
    .some(function isRenamed (name) { return env[name + '_collection'] !== name; });
};

module.exports = init;
