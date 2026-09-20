'use strict';

var countParam = require('../server/count');

function create (env, ctx) {
  var express = require('express')
    ,  app = express( )
    ;

  require('../middleware/configure-request')(app);

  app.set('trust proxy', require('../server/client-ip').compileTrust(env.trustProxy));

  const wares = ctx.wares;

  // set up express app with our options
  app.set('name', env.name);
  app.set('version', env.version);

  app.set('units', env.DISPLAY_UNITS);
  // Only allow access to the API if API KEY is set on the server.
  app.disable('api');
  if (env.enclave.isApiKeySet()) {
    console.log('API KEY present, enabling API');
    app.enable('api');
  } else {
    console.log('API KEY has not been set, API disabled');
  }
  if (env.settings.enable) {
    app.extendedClientSettings = ctx.plugins && ctx.plugins.extendedClientSettings ? ctx.plugins.extendedClientSettings(env.extendedSettings) : {};
    env.settings.enable.forEach(function (enable) {
      console.info('enabling feature:', enable);
      app.enable(enable);
    });
  }

  app.set('title', [app.get('name'),  'API', app.get('version')].join(' '));

 // Start setting up routes
  if (app.enabled('api')) {
    // experiments
    app.use('/experiments', require('./experiments/')(app, wares, ctx));
  }


  app.use(wares.extensions([
    'json', 'svg', 'csv', 'txt', 'png', 'html', 'tsv'
  ]));

  // `?count=` says how many documents a read wants.  Refuse anything that is
  // not a whole number of documents rather than letting `parseInt` guess: `0`
  // is the dangerous one, because MongoDB defines `.limit(0)` as *no limit*,
  // so a request for zero documents would be answered with the whole
  // collection.  `-3`, `abc` and `1e2` all read as some other number too.
  app.use(function validateCount (req, res, next) {
    const requested = req.query && req.query.count;

    if (countParam.hasCount(requested) && countParam.parseCount(requested) === null) {
      return res.status(400).json({
        status: 400
        , message: 'Bad count'
        , description: 'count must be a whole number of documents, 1 or greater'
      });
    }

    next( );
  });

  var entriesRouter = require('./entries/')(app, wares, ctx, env);
  // Entries and settings
  app.all(/^\/entries.*$/i, entriesRouter);
  app.all(/^\/echo\/.*$/i, entriesRouter);
  app.all(/^\/times\/.*$/i, entriesRouter);
  app.all(/^\/slice\/.*$/i, entriesRouter);
  app.all(/^\/count\/.*$/i, entriesRouter);

  app.all(/^\/treatments.*$/i, require('./treatments/')(app, wares, ctx, env));
  app.all(/^\/profile.*$/i, require('./profile/')(app, wares, ctx));
  app.all(/^\/devicestatus.*$/i, require('./devicestatus/')(app, wares, ctx, env));
  app.all(/^\/notifications.*$/i, require('./notifications-api')(app, wares, ctx));

  app.all(/^\/activity.*$/i, require('./activity/')(app, wares, ctx));

  app.use('/', wares.sendJSONStatus, require('./verifyauth')(ctx));

  app.use('/', wares.sendJSONStatus, require('./adminnotifiesapi')(ctx));

  app.all(/^\/food.*$/i, require('./food/')(app, wares, ctx));

  // Status first
  app.all(/^\/status.*$/i, require('./status')(app, wares, env, ctx));

  if (ctx.alexa) {
    app.all(/^\/alexa.*$/i, require('./alexa/')(app, wares, ctx, env));
  }

  if (ctx.googleHome) {
    app.all(/^\/googlehome.*$/i, require('./googlehome/')(app, wares, ctx, env));
  }

  return app;
}

module.exports = create;
