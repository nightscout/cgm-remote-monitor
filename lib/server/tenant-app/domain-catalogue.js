'use strict';

const dates = require('../../api3/generic/setup');
const names = Object.freeze(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings']);
const legacyNames = Object.freeze(names.filter(name => name !== 'settings'));
const loaders = Object.freeze({
  entries: () => [require('./entries'), require('../../../migrations/candidates/postgres-entries-v1.json')],
  treatments: () => [require('./treatments'), require('../../../migrations/candidates/postgres-treatments-v1.json')],
  devicestatus: () => [require('./devicestatus'), require('../../../migrations/candidates/postgres-devicestatus-v1.json')],
  profile: () => [require('./profile'), require('../../../migrations/candidates/postgres-profile-v1.json')],
  food: () => [require('./food'), require('../../../migrations/candidates/postgres-food-v1.json')],
  activity: () => [require('./activity'), require('../../../migrations/candidates/postgres-activity-v1.json')],
  settings: () => [require('./settings'), require('../../../migrations/candidates/postgres-settings-v1.json')]
});

function get (logical) {
  if (!names.includes(logical)) throw new TypeError('Unknown preview domain');
  const [factory, catalogue] = loaders[logical]();
  return {
    logical,
    factory, catalogue,
    legacy: legacyNames.includes(logical),
    v3: logical !== 'activity',
    ...(logical === 'entries' ? {
      fallbackGetDate: dates.fallbackDate, fallbackDateField: 'date', dedupFallbackFields: ['date', 'type']
    } : logical === 'settings' ? {} : {
      fallbackGetDate: dates.fallbackCreatedAt, fallbackDateField: 'created_at',
      dedupFallbackFields: ['created_at', ...(['treatments', 'devicestatus'].includes(logical)
        ? [logical === 'treatments' ? 'eventType' : 'device'] : [])]
    })
  };
}

module.exports = Object.freeze({ names, legacyNames, get });
