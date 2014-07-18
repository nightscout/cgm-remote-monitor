'use strict';

var consts = require('./constants');

/*
 * API - Expose Nightscout HTTP API
 * This implementation is designed to work with express.
 */

function create (env, entries, settings) {
  var express = require('express'),
      app = express( );

  var wares = require('./middleware/')(env);
  app.disable('api');
  if (env.api_secret) {
    console.log("API_SECRET", env.api_secret);
    app.enable('api');
  }
  // set up express basics
  app.set('title', 'Nightscout API v1');
  return configure.call(app, wares, entries, settings);
}

function configure (wares, entries, settings) {

    // our globals
    var express = require('express'),
        // app = express( ),
        app = this,
        api = express.Router( )
    ;

    /*
     * Start setting up routes
     */

    // Some experiments
    app.use('/experiments', require('./api/experiments/')(app, wares));

    app.use('/status', require('./api/status')(app, wares));
    /**********\
     * Entries
    \**********/
    app.use('/entries', require('./api/entries/')(app, wares, entries));

    /**********\
     * Settings
    \**********/
    app.use('/settings', require('./api/settings/')(app, wares, settings));

    app.use(api);

    return app;
}

create.configure = configure;
module.exports = create;

