
function create (env, entries, settings) {
  var express = require('express'),
      app = express( )
  ;

  var wares = require('../middleware/')(env);

  // Only allow access to the API if API_SECRET is set on the server.
  app.disable('api');
  if (env.api_secret) {
    console.log("API_SECRET", env.api_secret);
    app.enable('api');
  }

  // set up express basics
  app.set('title', 'Nightscout API v1');

  /*
   * Start setting up routes
   */

  if (app.enabled('api')) {
    app.use('/experiments', require('./experiments/')(app, wares));
  }

  /**********\
   * Entries
  \**********/
  app.use('/entries', require('./entries/')(app, wares, entries));

  /**********\
   * Settings
  \**********/
  app.use('/settings', require('./settings/')(app, wares, settings));

  app.use('/status', require('./status')(app, wares));
  return app;
}

module.exports = create;
