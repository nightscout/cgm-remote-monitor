'use strict';

const dates = require('../../api3/generic/setup');
const names = Object.freeze(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings']);
const legacyNames = Object.freeze(names.filter(name => name !== 'settings'));

function get (logical) {
  if (!names.includes(logical)) throw new TypeError('Unknown preview domain');
  return {
    logical,
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
