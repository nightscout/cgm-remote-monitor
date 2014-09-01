// NightScout server file

// NightScout is free software: you can redistribute it and/or modify it under the terms of the GNU
// General Public License as published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

// NightScout is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
// even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License along with NightScout.
// If not, see <http://www.gnu.org/licenses/>.

// Description: Basic web server to display data from Dexcom G4.  Requires a database that contains
// the Dexcom SGV data.
'use strict';

///////////////////////////////////////////////////
// DB Connection setup and utils
///////////////////////////////////////////////////

var software = require('./package.json');
var env = require('./env')( );
var store = require('./lib/storage')(env);


var express = require('express');

var pushover = require('./lib/pushover')(env);
///////////////////////////////////////////////////
// api and json object variables
///////////////////////////////////////////////////
var entries = require('./lib/entries')(env.mongo_collection, store);
var settings = require('./lib/settings')(env.settings_collection, store);
var treatments = require('./lib/treatments')(env.treatments_collection, store, pushover);
var devicestatus = require('./lib/devicestatus')(env.devicestatus_collection, store);
var api = require('./lib/api/')(env, entries, settings, treatments, devicestatus);
var pebble = require('./lib/pebble');
///////////////////////////////////////////////////

///////////////////////////////////////////////////
// setup http server
///////////////////////////////////////////////////
var PORT = env.PORT;

var app = express();
var appInfo = software.name + ' ' + software.version;
app.set('title', appInfo);
app.enable('trust proxy'); // Allows req.secure test on heroku https connections.

//if (env.api_secret) {
//    console.log("API_SECRET", env.api_secret);
//}
app.use('/api/v1', api);

// pebble data
app.get('/pebble', pebble(entries, devicestatus));

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

store(function ready ( ) {
  var server = app.listen(PORT);
  console.log('listening', PORT);

  ///////////////////////////////////////////////////
  // setup socket io for data and message transmission
  ///////////////////////////////////////////////////
  var websocket = require('./lib/websocket');
  var io = websocket(env, server, entries, treatments);
});

///////////////////////////////////////////////////
