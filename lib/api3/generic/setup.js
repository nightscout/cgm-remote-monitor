'use strict';

const dateTools = require('../shared/dateTools')
  , Collection = require('./collection')
  ;


/**
 * Extracts a Date object from the document's date field
 * @param {Object} doc - Document containing a date field
 * @returns {Date|null} Parsed date or null if invalid
 */
function fallbackDate (doc) {
  const m = dateTools.parseToMoment(doc.date);
  return m == null || !m.isValid()
    ? null
    : m.toDate();
}


/**
 * Extracts a Date object from the document's created_at field
 * @param {Object} doc - Document containing a created_at field
 * @returns {Date|null} Parsed date or null if invalid
 */
function fallbackCreatedAt (doc) {
  const m = dateTools.parseToMoment(doc.created_at);
  return m == null || !m.isValid()
    ? null
    : m.toDate();
}


function setupGenericCollections (ctx, env, app) {
  const cols = { }
    , enabledCols = app.get('enabledCollections');

  if (enabledCols?.includes('devicestatus')) {
    cols.devicestatus = new Collection({
      ctx, env, app,
      colName: 'devicestatus',
      storageColName: env.devicestatus_collection || 'devicestatus',
      fallbackGetDate: fallbackCreatedAt,
      dedupFallbackFields: ['created_at', 'device'],
      fallbackDateField: 'created_at'
    });
  }

  const entriesCollection = new Collection({
    ctx, env, app,
    colName: 'entries',
    storageColName: env.entries_collection || 'entries',
    fallbackGetDate: fallbackDate,
    dedupFallbackFields: ['date', 'type'],
    fallbackDateField: 'date'
  });
  app.set('entriesCollection', entriesCollection);

  if (enabledCols?.includes('entries')) {
    cols.entries = entriesCollection;
  }
  if (enabledCols?.includes('food')) {
    cols.food = new Collection({
      ctx, env, app,
      colName: 'food',
      storageColName: env.food_collection || 'food',
      fallbackGetDate: fallbackCreatedAt,
      dedupFallbackFields: ['created_at'],
      fallbackDateField: 'created_at'
    });
  }
  if (enabledCols?.includes('profile')) {
    cols.profile = new Collection({
      ctx, env, app,
      colName: 'profile',
      storageColName: env.profile_collection || 'profile',
      fallbackGetDate: fallbackCreatedAt,
      dedupFallbackFields: ['created_at'],
      fallbackDateField: 'created_at'
    });
  }
  if (enabledCols?.includes('settings')) {
    cols.settings = new Collection({
      ctx, env, app,
      colName: 'settings',
      storageColName: env.settings_collection || 'settings'
    });
  }
  if (enabledCols?.includes('treatments')) {
    cols.treatments = new Collection({
      ctx, env, app,
      colName: 'treatments',
      storageColName: env.treatments_collection || 'treatments',
      fallbackGetDate: fallbackCreatedAt,
      dedupFallbackFields: ['created_at', 'eventType'],
      fallbackDateField: 'created_at'
    });
  }

  Object.values(cols).forEach(function forMember (col) {
    col.mapRoutes();
  });

  app.set('collections', cols);
}


module.exports = setupGenericCollections;
