'use strict';

function setENVTruthy (app, varName, defaultValue) {
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


function setupApiEnvironment (app, env) {
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

  setENVTruthy(app, 'API3_SECURITY_ENABLE', apiConst.API3_SECURITY_ENABLE);
  setENVTruthy(app, 'API3_TIME_SKEW_TOLERANCE', apiConst.API3_TIME_SKEW_TOLERANCE);
  setENVTruthy(app, 'API3_DEDUP_FALLBACK_ENABLED', apiConst.API3_DEDUP_FALLBACK_ENABLED);
}


function setupApiRoutes (app, env, ctx) {
  var wares = require('../middleware/')(env)
    , authBuilder = require('./authBuilder')(app, env, ctx)

  app.get('/swagger.yaml', function getSwagger (req, res) {
    res.sendFile(__dirname + '/swagger.yaml');
  });

  app.get('/version', require('./version')(app, wares, env, ctx));

  app.get('/test', wares.sendJSONStatus, authBuilder('api:entries:read'), function test (req, res) {
    res.status(200).end();
  });
}


function create (env, ctx) {
  var express = require('express')
    , app = express()

  setupApiEnvironment(app, env);

  setupApiRoutes(app, env, ctx);

  return app;
}

module.exports = create;
