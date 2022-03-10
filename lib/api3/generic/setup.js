'use strict';

const _ = require('lodash')
  , dateTools = require('../shared/dateTools')
  , Collection = require('./collection')
  ;


function fallbackDate (doc) {
  const m = dateTools.parseToMoment(doc.date);
  return m == null || !m.isValid()
    ? null
    : m.toDate();
}


function fallbackCreatedAt (doc) {
  const m = dateTools.parseToMoment(doc.created_at);
  return m == null || !m.isValid()
    ? null
    : m.toDate();
}


function setupGenericCollections (ctx, env, app) {
  const cols = { }
    , enabledCols = app.get('enabledCollections');

  if (_.includes(enabledCols, 'devicestatus')) {
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

  if (_.includes(enabledCols, 'entries')) {
    cols.entries = entriesCollection;
  }

  if (_.includes(enabledCols, 'food')) {
    cols.food = new Collection({
      ctx, env, app,
      colName: 'food',
      storageColName: env.food_collection || 'food',
      fallbackGetDate: fallbackCreatedAt,
      dedupFallbackFields: ['created_at'],
      fallbackDateField: 'created_at'
    });
  }

  if (_.includes(enabledCols, 'profile')) {
    cols.profile = new Collection({
      ctx, env, app,
      colName: 'profile',
      storageColName: env.profile_collection || 'profile',
      fallbackGetDate: fallbackCreatedAt,
      dedupFallbackFields: ['created_at'],
      fallbackDateField: 'created_at'
    });
  }

  if (_.includes(enabledCols, 'settings')) {
    cols.settings = new Collection({
      ctx, env, app,
      colName: 'settings',
      storageColName: env.settings_collection || 'settings'
    });
  }

  if (_.includes(enabledCols, 'treatments')) {
    cols.treatments = new Collection({
      ctx, env, app,
      colName: 'treatments',
      storageColName: env.treatments_collection || 'treatments',
      fallbackGetDate: fallbackCreatedAt,
      dedupFallbackFields: ['created_at', 'eventType'],
      fallbackDateField: 'created_at'
    });
  }

  _.forOwn(cols, function forMember (col) {
    col.mapRoutes();
  });

  app.set('collections', cols);
}


module.exports = setupGenericCollections;
