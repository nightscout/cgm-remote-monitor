'use strict';

function create (env, entries, settings, treatments, devicestatus) {
  var express = require('express'),
      app = express( )
  ;

  var wares = require('../middleware/')(env);

  // set up express app with our options
  app.set('name', env.name);
  app.set('version', env.version);
  // app.set('head', env.head);
  function get_head ( ) {
    return env.head;
  }
  wares.get_head = get_head;
  app.set('units', env.DISPLAY_UNITS);
  // Only allow access to the API if API_SECRET is set on the server.
  app.disable('api');
  if (env.api_secret) {
    console.log("API_SECRET", env.api_secret);
    app.enable('api');
  }

  if (env.enable) {
    env.enable.toLowerCase().split(' ').forEach(function (value) {
      var enable = value.trim();
      console.info("enabling feature:", enable);
      app.enable(enable);
    });
  }

  app.set('title', [app.get('name'),  'API', app.get('version')].join(' '));

 // Start setting up routes
  if (app.enabled('api')) {
    // experiments
    app.use('/experiments', require('./experiments/')(app, wares));
  }

  // Entries and settings
  app.use('/', require('./entries/')(app, wares, entries));
  app.use('/', require('./settings/')(app, wares, settings));
  app.use('/', require('./treatments/')(app, wares, treatments));
  app.use('/', require('./devicestatus/')(app, wares, devicestatus));

  // Status
  app.use('/', require('./status')(app, wares));
  return app;
}

module.exports = create;
