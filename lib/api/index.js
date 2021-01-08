'use strict';

function create (env, ctx) {
  var _each = require('lodash/each')
    , express = require('express')
    ,  app = express( )
    ;

  var wares = require('../middleware/')(env);

  // set up express app with our options
  app.set('name', env.name);
  app.set('version', env.version);

  app.set('units', env.DISPLAY_UNITS);
  // Only allow access to the API if API_SECRET is set on the server.
  app.disable('api');
  if (env.api_secret) {
    console.log('API_SECRET present, enabling API');
    app.enable('api');
  } else {
    console.log('API_SECRET not found, API disabled');
  }

  if (env.settings.enable) {
    app.extendedClientSettings = ctx.plugins && ctx.plugins.extendedClientSettings ? ctx.plugins.extendedClientSettings(env.extendedSettings) : {};
    _each(env.settings.enable, function (enable) {
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
