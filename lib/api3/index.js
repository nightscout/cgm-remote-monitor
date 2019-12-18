'use strict';

const express = require('express')
  , bodyParser = require('body-parser')
  , StorageSocket = require('./storageSocket')
  , apiConst = require('./const.json')
  , security = require('./security')
  , genericSetup = require('./generic/setup')
  , swaggerSetup = require('./swagger')
  ;

function configure (env, ctx) {

  const self = { }
    , app = express()
    ;

  self.setENVTruthy = function setENVTruthy (varName, defaultValue) {
    //for some reason Azure uses this prefix, maybe there is a good reason
    let value = process.env['CUSTOMCONNSTR_' + varName]
      || process.env['CUSTOMCONNSTR_' + varName.toLowerCase()]
      || process.env[varName]
      || process.env[varName.toLowerCase()];

    value = value != null ? value : defaultValue;

    if (typeof value === 'string' && (value.toLowerCase() === 'on' || value.toLowerCase() === 'true')) { value = true; }
    if (typeof value === 'string' && (value.toLowerCase() === 'off' || value.toLowerCase() === 'false')) { value = false; }

    app.set(varName, value);
    return value;
  };
  app.setENVTruthy = self.setENVTruthy;


  self.setupApiEnvironment = function setupApiEnvironment () {
    
    app.use(bodyParser.json({
      limit: 1048576 * 50
    }), function errorHandler (err, req, res, next) {
      console.error(err);
      res.status(apiConst.HTTP.INTERNAL_ERROR).json({
        status: apiConst.HTTP.INTERNAL_ERROR,
        message: apiConst.MSG.HTTP_500_INTERNAL_ERROR
      });
      if (next) { // we need 4th parameter next to behave like error handler, but we have to use it to prevent "unused variable" message
      }
    });

    // we don't need these here
    app.set('etag', false);
    app.set('x-powered-by', false); // this seems to be unreliable
    app.use(function (req, res, next) {
      res.removeHeader('x-powered-by');
      next();
    });

    app.set('name', env.name);
    app.set('version', env.version);
    app.set('apiVersion', apiConst.API3_VERSION);
    app.set('units', env.DISPLAY_UNITS);
    app.set('ci', process.env['CI'] ? true: false);
    app.set('enabledCollections', ['devicestatus', 'entries', 'food', 'profile', 'settings', 'treatments']);

    self.setENVTruthy('API3_SECURITY_ENABLE', apiConst.API3_SECURITY_ENABLE);
    self.setENVTruthy('API3_TIME_SKEW_TOLERANCE', apiConst.API3_TIME_SKEW_TOLERANCE);
    self.setENVTruthy('API3_DEDUP_FALLBACK_ENABLED', apiConst.API3_DEDUP_FALLBACK_ENABLED);
    self.setENVTruthy('API3_CREATED_AT_FALLBACK_ENABLED', apiConst.API3_CREATED_AT_FALLBACK_ENABLED);
    self.setENVTruthy('API3_MAX_LIMIT', apiConst.API3_MAX_LIMIT);
  };


  self.setupApiRoutes = function setupApiRoutes () {

    app.get('/version', require('./specific/version')(app, ctx, env));

    if (app.get('env') === 'development' || app.get('ci')) { // for development and testing purposes only
      app.get('/test', async function test (req, res) {

        try {
          const opCtx = {app, ctx, env, req, res};
          opCtx.auth = await security.authenticate(opCtx);
          await security.demandPermission(opCtx, 'api:entries:read');
          res.status(apiConst.HTTP.OK).end();
        } catch (error) {
          console.error(error);
        }
      });
    }

    app.get('/lastModified', require('./specific/lastModified')(app, ctx, env));

    app.get('/status', require('./specific/status')(app, ctx, env));
  };


  self.setupApiEnvironment();
  genericSetup(ctx, env, app);
  self.setupApiRoutes();
  swaggerSetup(app);

  ctx.storageSocket = new StorageSocket(app, env, ctx);

  return app;
}

module.exports = configure;
