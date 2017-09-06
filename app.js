'use strict';

var express = require('express');
var compression = require('compression');
var bodyParser = require('body-parser');

function create (env, ctx) {
  var app = express();
  var appInfo = env.name + ' ' + env.version;
  app.set('title', appInfo);
  app.enable('trust proxy'); // Allows req.secure test on heroku https connections.

  if (ctx.bootErrors && ctx.bootErrors.length > 0) {
    app.get('*', require('./lib/booterror')(ctx));
    return app;
  }

  ///////////////////////////////////////////////////
  // api and json object variables
  ///////////////////////////////////////////////////
  var api = require('./lib/api/')(env, ctx);

  app.use(compression({filter: function shouldCompress(req, res) {
    //TODO: return false here if we find a condition where we don't want to compress
    // fallback to standard filter function
    return compression.filter(req, res);
  }}));
  // app.use(bodyParser({limit: 1048576 * 50, extended: true }));

  //if (env.api_secret) {
  //    console.log("API_SECRET", env.api_secret);
  //}
  app.use('/api/v1', bodyParser({limit: 1048576 * 50 }), api);

  app.use('/api/v2/properties', ctx.properties);
  app.use('/api/v2/authorization', ctx.authorization.endpoints);

  // pebble data
  app.get('/pebble', ctx.pebble);

  // expose swagger.yaml
  app.get('/swagger.yaml', function (req, res) {
    res.sendFile(__dirname + '/swagger.yaml');
  });

  //app.get('/package.json', software);

  // define static server
  //TODO: JC - changed cache to 1 hour from 30d ays to bypass cache hell until we have a real solution
  var staticFiles = express.static(env.static_files, {maxAge: 60 * 60 * 1000});

  // serve the static content
  app.use(staticFiles);

  var bundle = require('./bundle')();
  app.use(bundle);

  // Handle errors with express's errorhandler, to display more readable error messages.
  var errorhandler = require('errorhandler');
  //if (process.env.NODE_ENV === 'development') {
    app.use(errorhandler());
  //}
  return app;
}
module.exports = create;

