
var express = require('express');
function create (env, ctx) {
  ///////////////////////////////////////////////////
  // api and json object variables
  ///////////////////////////////////////////////////
  var api = require('./lib/api/')(env, ctx.entries, ctx.settings, ctx.treatments, ctx.devicestatus, ctx.inputs);
  var pebble = ctx.pebble;

  var app = express();
  app.entries = ctx.entries;
  app.treatments = ctx.treatments;
  var appInfo = env.name + ' ' + env.version;
  app.set('title', appInfo);
  app.enable('trust proxy'); // Allows req.secure test on heroku https connections.

  //if (env.api_secret) {
  //    console.log("API_SECRET", env.api_secret);
  //}
  app.use('/api/v1', api);


  // pebble data
  app.get('/pebble', pebble(ctx.entries, ctx.devicestatus));

  //app.get('/package.json', software);

  // define static server
  //TODO: JC - changed cache to 1 hour from 30d ays to bypass cache hell until we have a real solution
  var staticFiles = express.static(env.static_files, {maxAge: 60 * 60 * 1000});

  // serve the static content
  app.use(staticFiles);

  // Handle errors with express's errorhandler, to display more readable error messages.
  var errorhandler = require('errorhandler');
  //if (process.env.NODE_ENV === 'development') {
    app.use(errorhandler());
  //}
  return app;
}
module.exports = create;

