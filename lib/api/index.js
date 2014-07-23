'use strict';

function create (env, entries, settings) {
  var express = require('express'),
      app = express( )
  ;

  var wares = require('../middleware/')(env);

  // set up express app with our options
  // Only allow access to the API if API_SECRET is set on the server.
  app.disable('api');
  if (env.api_secret) {
    console.log("API_SECRET", env.api_secret);
    app.enable('api');
  }

  app.set('title', 'Nightscout API v1');

 // Start setting up routes
  if (app.enabled('api')) {
    // experiments
    app.use('/experiments', require('./experiments/')(app, wares));
  }

  // Entries and settings
  app.use('/entries', require('./entries/')(app, wares, entries));
  app.use('/settings', require('./settings/')(app, wares, settings));

  // Status
  app.use('/status', require('./status')(app, wares));
  return app;
}

module.exports = create;
