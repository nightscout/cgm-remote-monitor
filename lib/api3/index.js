'use strict';

const _ = require('lodash')
  , express = require('express')
  , bodyParser = require('body-parser')
  , StorageSocket = require('./storageSocket')
  , apiConst = require('./const.json')
  , security = require('./security')
  , dateTools = require('./shared/dateTools')
  , fs = require('fs')
  ;

function configure (env, ctx) {

  const self = { }
    , wares = require('../middleware/')(env)
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
    
    app.use(bodyParser({
      limit: 1048576 * 50
    }), function errorHandler (err, req, res, next) {
      console.error(err);
      res.status(500).json({
        status: 500,
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
    app.set('enabledCollections', ['devicestatus', 'entries', 'food', 'profile', 'settings', 'treatments']);

    self.setENVTruthy('API3_SECURITY_ENABLE', apiConst.API3_SECURITY_ENABLE);
    self.setENVTruthy('API3_TIME_SKEW_TOLERANCE', apiConst.API3_TIME_SKEW_TOLERANCE);
    self.setENVTruthy('API3_DEDUP_FALLBACK_ENABLED', apiConst.API3_DEDUP_FALLBACK_ENABLED);
    self.setENVTruthy('API3_CREATED_AT_FALLBACK_ENABLED', apiConst.API3_CREATED_AT_FALLBACK_ENABLED);
    self.setENVTruthy('API3_MAX_LIMIT', apiConst.API3_MAX_LIMIT);
  };


  self.setupApiRoutes = function setupApiRoutes () {

    app.get('/version', require('./specific/version')(app, ctx, env));

    if (app.get('env') === 'development') { // for development and testing purposes only
      app.get('/test', async function test (req, res) {

        try {
          const opCtx = {app, ctx, env, req, res};
          opCtx.auth = await security.authenticate(opCtx);
          await security.demandPermission(opCtx, 'api:entries:read');
          res.status(200).end();
        } catch (error) {
          console.error(error);
        }
      });
    }

    app.get('/lastModified', require('./specific/lastModified')(app, ctx, env));

    app.get('/status', require('./specific/status')(app, ctx, env));
  };


  self.fallbackDate = function fallbackDate (doc) {
    const m = dateTools.parseToMoment(doc.date);
    return m == null || !m.isValid()
      ? null
      : m.toDate();
  };


  self.fallbackCreatedAt = function fallbackCreatedAt (doc) {
    const m = dateTools.parseToMoment(doc.created_at);
    return m == null || !m.isValid()
      ? null
      : m.toDate();
  };


  self.setupGenericCollections = function setupGenericCollections () {
    const cols = { }
      , Collection = require('./generic/collection')
      , enabledCols = app.get('enabledCollections');

    if (_.includes(enabledCols, 'devicestatus')) {
      cols.devicestatus = new Collection({ 
        ctx, env, app,
        colName: 'devicestatus', 
        storageColName: env.devicestatus_collection || 'devicestatus',
        fallbackGetDate: self.fallbackCreatedAt, 
        dedupFallbackFields: ['created_at', 'device'], 
        fallbackDateField: 'created_at' 
      });
    }

    const entriesCollection = new Collection({
      ctx, env, app,
      colName: 'entries', 
      storageColName: env.entries_collection || 'entries',
      fallbackGetDate: self.fallbackDate, 
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
        fallbackGetDate: self.fallbackCreatedAt, 
        dedupFallbackFields: ['created_at'], 
        fallbackDateField: 'created_at'
      });
    }

    if (_.includes(enabledCols, 'profile')) {
      cols.profile = new Collection({
        ctx, env, app,
        colName: 'profile', 
        storageColName: env.profile_collection || 'profile',
        fallbackGetDate: self.fallbackCreatedAt, 
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
        fallbackGetDate: self.fallbackCreatedAt, 
        dedupFallbackFields: ['created_at', 'eventType'], 
        fallbackDateField: 'created_at'
      });
    }

    _.forOwn(cols, function forMember (col) {
      col.mapRoutes();
    });

    app.set('collections', cols);
  };


  self.setupSwaggerUI = function setupSwaggerUI () {

    const serveSwaggerDef = function serveSwaggerDef (req, res) {
      res.sendFile(__dirname + '/swagger.yaml');
    };
    app.get('/swagger.yaml', serveSwaggerDef);

    const swaggerUiAssetPath = require('swagger-ui-dist').getAbsoluteFSPath();
    const swaggerFiles = express.static(swaggerUiAssetPath);

    var urlRegex = /url: "[^"]*",/;

    const patchIndex = function patchIndex (req, res) {
      const indexContent = fs.readFileSync(`${swaggerUiAssetPath}/index.html`)
        .toString()
        .replace(urlRegex, 'url: "../swagger.yaml",');
      res.send(indexContent);
    };

    app.get('/swagger-ui-dist', function getSwaggerRoot (req, res) {
      let targetUrl = req.originalUrl;
      if (!targetUrl.endsWith('/')) {
        targetUrl += '/';
      }
      targetUrl += 'index.html';
      res.redirect(targetUrl);
    });
    app.get('/swagger-ui-dist/index.html', patchIndex);

    app.use('/swagger-ui-dist', swaggerFiles);
  };


  self.setupApiEnvironment();

  app.use(wares.sendJSONStatus);

  self.setupGenericCollections();
  self.setupApiRoutes();
  self.setupSwaggerUI();

  ctx.storageSocket = new StorageSocket(app, env, ctx);

  return app;
}

module.exports = configure;
