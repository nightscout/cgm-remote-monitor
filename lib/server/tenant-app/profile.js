'use strict';

const collectionIntent = require('../../storage/postgres-collection-intent');
const dateTools = require('../../api3/shared/dateTools');
const errors = require('./profile-food-errors');

// Trusted constructor options; startDate remains a legacy profile concern.
module.exports = function profile ({ connection, table = 'profile', bus, env, source = 'v3' } = {}) {
  const step = collectionIntent({ connection, table, logical: 'profile', bus, env, source });
  return {
    ...errors(step),
    fallbackGetDate (doc) {
      const m = dateTools.parseToMoment(doc.created_at);
      return m && m.isValid() ? m.toDate() : null;
    },
    fallbackDateField: 'created_at',
    dedupFallbackFields: ['created_at']
  };
};
