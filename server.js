/*
* cgm-remote-monitor - web app to broadcast cgm readings
* Copyright (C) 2014 Nightscout contributors.  See the COPYRIGHT file
* at the root directory of this distribution and at
* https://github.com/nightscout/cgm-remote-monitor/blob/master/COPYRIGHT
*
* This program is free software: you can redistribute it and/or modify
* it under the terms of the GNU Affero General Public License as published
* by the Free Software Foundation, either version 3 of the License, or
* (at your option) any later version.
*
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU Affero General Public License for more details.
*
* You should have received a copy of the GNU Affero General Public License
* along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// Description: Basic web server to display data from Dexcom G4.  Requires a database that contains
// the Dexcom SGV data.
'use strict';

///////////////////////////////////////////////////
// DB Connection setup and utils
///////////////////////////////////////////////////

var env = require('./env')( );
var store = require('./lib/storage')(env);

///////////////////////////////////////////////////

///////////////////////////////////////////////////
// setup http server
///////////////////////////////////////////////////
var PORT = env.PORT;

var bootevent = require('bootevent');
bootevent( )
  .acquire(function db (ctx, next) {
    // initialize db connections
    store( function ready ( ) {
      console.log('storage system ready');
      ctx.store = store;
      next( );
    });
  })
  .boot(function booted (ctx) {
    env.store = ctx.store;
    var app = require('./app')(env);
    var server = app.listen(PORT);
    console.log('listening', PORT);
    ///////////////////////////////////////////////////
    // setup socket io for data and message transmission
    ///////////////////////////////////////////////////
    var websocket = require('./lib/websocket');
    var io = websocket(env, server, app.entries, app.treatments);
  })
;

///////////////////////////////////////////////////
