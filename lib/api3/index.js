'use strict';

function configure (env, ctx) {

  var self = { }
    , _ = require('lodash')
    , wares = require('../middleware/')(env)
    , express = require('express')
    , app = express()
    , authBuilder = require('./authBuilder')(app, env, ctx)

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
  }


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

    self.setENVTruthy('API3_SECURITY_ENABLE', apiConst.API3_SECURITY_ENABLE);
    self.setENVTruthy('API3_TIME_SKEW_TOLERANCE', apiConst.API3_TIME_SKEW_TOLERANCE);
    self.setENVTruthy('API3_DEDUP_FALLBACK_ENABLED', apiConst.API3_DEDUP_FALLBACK_ENABLED);
  }


  self.setupApiRoutes = function setupApiRoutes () {

    app.use(wares.sendJSONStatus);

    app.get('/swagger.yaml', function getSwagger (req, res) {
      res.sendFile(__dirname + '/swagger.yaml');
    });

    app.get('/version', require('./version')(app, wares, env, ctx));

    if (app.get('env') === 'development') { // for development and testing purposes only
      app.get('/test', authBuilder('api:entries:read'), function test (req, res) {
        res.status(200).end();
      });
    }
  }


  self.setupGenericCollections = function setupGenericCollections () {
    var cols = { }
      , colBuilder = require('./colBuilder')(ctx, env, app)

    cols.devicestatus = colBuilder(env.devicestatus_collection);
    cols.entries = colBuilder(env.entries_collection);
    cols.food = colBuilder(env.food_collection);
    cols.profile = colBuilder(env.profile_collection);
    cols.treatments = colBuilder(env.treatments_collection);

    _.forOwn(cols, function forMember(col) {
      col.mapRoutes();
    });
  }


  self.setupApiEnvironment();
  self.setupApiRoutes();
  self.setupGenericCollections();

  return app;
}

module.exports = configure;
