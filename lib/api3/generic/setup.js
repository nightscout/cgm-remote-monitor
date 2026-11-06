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


/**
 * Storage collection name behind each API v3 collection
 * @param {Object} env
 * @returns {Object} map of API v3 collection name to storage collection name
 */
function storageColNames (env) {
  return {
    devicestatus: env.devicestatus_collection || 'devicestatus',
    entries: env.entries_collection || 'entries',
    food: env.food_collection || 'food',
    profile: env.profile_collection || 'profile',
    settings: env.settings_collection || 'settings',
    treatments: env.treatments_collection || 'treatments'
  };
}


function setupGenericCollections (ctx, env, app) {
  const cols = { }
    , enabledCols = app.get('enabledCollections')
    , storageNames = storageColNames(env);

  if (enabledCols?.includes('devicestatus')) {
    cols.devicestatus = new Collection({
      ctx, env, app,
      colName: 'devicestatus',
      storageColName: storageNames.devicestatus,
      fallbackGetDate: fallbackCreatedAt,
      dedupFallbackFields: ['created_at', 'device'],
      fallbackDateField: 'created_at'
    });
  }

  const entriesCollection = new Collection({
    ctx, env, app,
    colName: 'entries',
    storageColName: storageNames.entries,
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
      storageColName: storageNames.food,
      fallbackGetDate: fallbackCreatedAt,
      dedupFallbackFields: ['created_at'],
      fallbackDateField: 'created_at'
    });
  }
  if (enabledCols?.includes('profile')) {
    cols.profile = new Collection({
      ctx, env, app,
      colName: 'profile',
      storageColName: storageNames.profile,
      fallbackGetDate: fallbackCreatedAt,
      dedupFallbackFields: ['created_at'],
      fallbackDateField: 'created_at'
    });
  }
  if (enabledCols?.includes('settings')) {
    cols.settings = new Collection({
      ctx, env, app,
      colName: 'settings',
      storageColName: storageNames.settings
    });
  }
  if (enabledCols?.includes('treatments')) {
    cols.treatments = new Collection({
      ctx, env, app,
      colName: 'treatments',
      storageColName: storageNames.treatments,
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
module.exports.storageColNames = storageColNames;
