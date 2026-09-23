'use strict';

var countParam = require('../server/count');

function create (env, ctx) {
  var express = require('express')
    ,  app = express( )
    ;

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
  //
  // `count=0` itself is a valid request for no documents, and is answered
  // with an empty list by the storage layer (lib/server/count.js), never with
  // the whole collection.
  //
  // Only reads are checked.  No write uses `count`, so a write that happens to
  // carry one must not be refused because of it.
  app.use(function validateCount (req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next( );
    }

    const requested = req.query && req.query.count;

    if (countParam.hasCount(requested)
      && !countParam.isZeroCount(requested)
      && countParam.parseCount(requested) === null) {
      return res.status(400).json({
        status: 400
        , message: 'Bad count'
        , description: 'count must be a whole number of documents, 0 or greater'
      });
    }

    next( );
  });

  var entriesRouter = require('./entries/')(app, wares, ctx, env);
  // Entries and settings
  app.all('/entries*', entriesRouter);
  app.all('/echo/*', entriesRouter);
  app.all('/times/*', entriesRouter);
  app.all('/slice/*', entriesRouter);
  app.all('/count/*', entriesRouter);

  app.all('/treatments*', require('./treatments/')(app, wares, ctx, env));
  app.all('/profile*', require('./profile/')(app, wares, ctx));
  app.all('/devicestatus*', require('./devicestatus/')(app, wares, ctx, env));
  app.all('/notifications*', require('./notifications-api')(app, wares, ctx));

  app.all('/activity*', require('./activity/')(app, wares, ctx));

  app.use('/', wares.sendJSONStatus, require('./verifyauth')(ctx));

  app.use('/', wares.sendJSONStatus, require('./adminnotifiesapi')(ctx));

  app.all('/food*', require('./food/')(app, wares, ctx));

  // Status first
  app.all('/status*', require('./status')(app, wares, env, ctx));

  if (ctx.alexa) {
    app.all('/alexa*', require('./alexa/')(app, wares, ctx, env));
  }

  if (ctx.googleHome) {
    app.all('/googlehome*', require('./googlehome/')(app, wares, ctx, env));
  }

  return app;
}

module.exports = create;
