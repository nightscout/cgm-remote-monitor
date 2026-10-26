'use strict';

const express = require('express')

  , renderer = require('./shared/renderer')
  , storageSocket = require('./storageSocket')
  , alarmSocket = require('./alarmSocket')
  , apiConst = require('./const.json')
  , security = require('./security')
  , genericSetup = require('./generic/setup')
  , opTools = require('./shared/operationTools')
  ;

function configure (env, ctx) {

  const self = { }
    , app = express()
    ;

  require('../middleware/configure-request')(app);

  app.set('trust proxy', require('../server/client-ip').trustFor(env));

  // API v3's settings are read by lib/server/env.js; an env built some other
  // way (a test fixture, for example) gets the same reading.
  const settings = env.api3 || require('../server/env').readApi3Settings();

  self.setENVTruthy = function setENVTruthy (varName, defaultValue) {
    let value = settings[varName];
    value = value != null ? value : defaultValue;
    app.set(varName, value);
    return value;
  };
  app.setENVTruthy = self.setENVTruthy;


  self.setupApiEnvironment = function setupApiEnvironment () {

    app.use(express.json({
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

    app.use(renderer.extension2accept);

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
    app.set('ci', settings.CI);
    app.set('enabledCollections', ['devicestatus', 'entries', 'food', 'profile', 'settings', 'treatments']);

    self.setENVTruthy('API3_SECURITY_ENABLE', apiConst.API3_SECURITY_ENABLE);
    self.setENVTruthy('API3_DEDUP_FALLBACK_ENABLED', apiConst.API3_DEDUP_FALLBACK_ENABLED);
    self.setENVTruthy('API3_CREATED_AT_FALLBACK_ENABLED', apiConst.API3_CREATED_AT_FALLBACK_ENABLED);
    self.setENVTruthy('API3_MAX_LIMIT', apiConst.API3_MAX_LIMIT);
    self.setENVTruthy('API3_SETTINGS_STRICT_READ_ENABLED', apiConst.API3_SETTINGS_STRICT_READ_ENABLED);
  };


  self.setupApiRoutes = function setupApiRoutes () {

    app.get('/version', require('./specific/version')(app, ctx, env));

    if (app.get('env') === 'development' || app.get('env') === 'test' || app.get('ci')) { // for development and testing purposes only
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

  app.use('/swagger-ui-dist', (req, res) => {
    res.redirect(307, '../../../api3-docs');
  });

  app.use((req, res) => {
    opTools.sendJSONStatus(res, apiConst.HTTP.NOT_FOUND, apiConst.MSG.HTTP_404_BAD_OPERATION);
  })

  ctx.storageSocket = new storageSocket(app, env, ctx);
  ctx.alarmSocket = new alarmSocket(app, env, ctx);

  return app;
}

module.exports = configure;
