'use strict';

function configure (env, ctx) {

  var self = { }
    , _ = require('lodash')
    , wares = require('../middleware/')(env)
    , express = require('express')
    , app = express()
    , AuthorizerBuilder = require('./authorizerBuilder')
    , authBuilder = new AuthorizerBuilder(app, env, ctx)

  self.setENVTruthy = function setENVTruthy (varName, defaultValue) {
    //for some reason Azure uses this prefix, maybe there is a good reason
    var value = process.env['CUSTOMCONNSTR_' + varName]
      || process.env['CUSTOMCONNSTR_' + varName.toLowerCase()]
      || process.env[varName]
      || process.env[varName.toLowerCase()];

    value = value != null ? value : defaultValue;

    if (typeof value === 'string' && (value.toLowerCase() === 'on' || value.toLowerCase() === 'true')) { value = true; }
    if (typeof value === 'string' && (value.toLowerCase() === 'off' || value.toLowerCase() === 'false')) { value = false; }

    app.set(varName, value);
    return value;
  }
  app.setENVTruthy = self.setENVTruthy;


  self.setupApiEnvironment = function setupApiEnvironment () {
    var apiConst = require('./const.json')

    // we don't need these here
    app.set('etag', false);
    app.set('x-powered-by', false); // this seems to be unreliable
    app.use(function (req, res, next) {
      res.removeHeader("x-powered-by");
      next();
    });

    app.set('name', env.name);
    app.set('version', env.version);
    app.set('apiVersion', apiConst.API3_VERSION);
    app.set('units', env.DISPLAY_UNITS);
    app.set('enabledCollections', ['devicestatus', 'entries', 'food', 'profile', 'treatments']);

    self.setENVTruthy('API3_SECURITY_ENABLE', apiConst.API3_SECURITY_ENABLE);
    self.setENVTruthy('API3_TIME_SKEW_TOLERANCE', apiConst.API3_TIME_SKEW_TOLERANCE);
    self.setENVTruthy('API3_DEDUP_FALLBACK_ENABLED', apiConst.API3_DEDUP_FALLBACK_ENABLED);
    self.setENVTruthy('API3_CREATED_AT_FALLBACK_ENABLED', apiConst.API3_CREATED_AT_FALLBACK_ENABLED);
    self.setENVTruthy('API3_MAX_LIMIT', apiConst.API3_MAX_LIMIT);
  }


  self.setupApiRoutes = function setupApiRoutes () {

    app.get('/swagger.yaml', function getSwagger (req, res) {
      res.sendFile(__dirname + '/swagger.yaml');
    });

    app.get('/version', require('./specific/version')(app, wares, env, ctx));

    if (app.get('env') === 'development') { // for development and testing purposes only
           app.get('/test', authBuilder.authorizerFor('api:entries:read'), function test (req, res) {
        res.status(200).end();
      });
    }

    app.get('/lastModified', require('./specific/lastModified')(app, ctx, env, authBuilder));

    app.get('/status', require('./specific/status')(app, ctx, env, authBuilder));
  }


  self.fallbackDate = function fallbackDate (doc) {
    if (doc.dateString) {
      return new Date(doc.dateString);
    }
    return new Date(doc.date);
  }


  self.fallbackCreatedAt = function fallbackCreatedAt (doc) {
    if (doc.created_at) {
      return new Date(doc.created_at);
    }
    return null;
  }


  self.setupGenericCollections = function setupGenericCollections () {
    var cols = { }
      , Collection = require('./generic/collection')
      , enabledCols = app.get('enabledCollections');

    if (_.includes(enabledCols, 'devicestatus')) {
      cols.devicestatus = new Collection(ctx, env, app, authBuilder, 'devicestatus', env.devicestatus_collection,
        self.fallbackCreatedAt, ['created_at', 'device'], 'created_at');
    }

    var entriesCollection = new Collection(ctx, env, app, authBuilder, 'entries', env.entries_collection,
        self.fallbackDate, ['date', 'type'], 'date');
    app.set('entriesCollection', entriesCollection);

    if (_.includes(enabledCols, 'entries')) {
      cols.entries = entriesCollection;
    }

    if (_.includes(enabledCols, 'food')) {
      cols.food = new Collection(ctx, env, app, authBuilder, 'food', env.food_collection,
        self.fallbackCreatedAt, ['created_at'], 'created_at');
    }

    if (_.includes(enabledCols, 'profile')) {
      cols.profile = new Collection(ctx, env, app, authBuilder, 'profile', env.profile_collection,
        self.fallbackCreatedAt, ['created_at'], 'created_at');
    }

    if (_.includes(enabledCols, 'treatments')) {
      cols.treatments = new Collection(ctx, env, app, authBuilder, 'treatments', env.treatments_collection,
        self.fallbackCreatedAt, ['created_at', 'eventType'], 'created_at');
    }

    _.forOwn(cols, function forMember (col) {
      col.mapRoutes();
    });

    app.set('collections', cols);
  }

  self.setupApiEnvironment();

  app.use(wares.sendJSONStatus);

  self.setupGenericCollections();
  self.setupApiRoutes();

  return app;
}

module.exports = configure;
