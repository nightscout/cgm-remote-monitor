'use strict';

const collectionIntent = require('../../storage/postgres-collection-intent');
const dateTools = require('../../api3/shared/dateTools');
const errors = require('./profile-food-errors');

module.exports = function food ({ connection, table = 'food', bus, env, source = 'v3' } = {}) {
  // The legacy food lists are deliberately unsorted and unbounded. Preserve
  // insertion order across edits instead of inventing an identifier order.
  const step = collectionIntent({ connection, table, logical: 'food', bus, env, source, naturalOrder: true });
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
