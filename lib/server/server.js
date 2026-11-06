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

// Reject unsupported runtimes before loading configuration or starting services.
require('./runtime-policy')();

///////////////////////////////////////////////////
// DB Connection setup and utils
///////////////////////////////////////////////////

const fs = require('fs');
const env = require('./env')( );
const language = require('../language')();
const translate = language.set(env.settings.language).translate;
language.loadLocalization(fs);

///////////////////////////////////////////////////
// setup http server
///////////////////////////////////////////////////
var PORT = env.PORT;
var HOSTNAME = env.HOSTNAME;
// Under the 10 s `docker stop` waits before it kills the container.
var SHUTDOWN_BOUND_MS = 8000;

function create (app) {
  var transport = (env.ssl
                ? require('https') : require('http'));
  if (env.ssl) {
    return transport.createServer(env.ssl, app);
  }
  return transport.createServer(app);
}

require('./bootevent')(env, language).boot(function booted (ctx) {

    console.log('Boot event processing completed');

    var app = require('./app')(env, ctx);
    var server = create(app).listen(PORT, HOSTNAME);
    console.log(translate('Listening on port'), PORT, HOSTNAME);

    // SIGTERM (`docker stop`, a host restarting the app) and SIGINT stop the
    // server: the bus's teardown closes the listener, the socket and the
    // MongoDB client, and the process exits 0 once the listener has closed.
    // Without a handler, node running as PID 1 in the image ignores both and
    // is killed when the stop timeout runs out. If the listener is still open
    // after SHUTDOWN_BOUND_MS, the process exits 1.
    var stopping = false;
    function shutdown (signal) {
      if (stopping) return;
      stopping = true;
      console.log('Received ' + signal + ', shutting down');
      var watchdog = setTimeout(function stillOpen () {
        console.error('Still open ' + SHUTDOWN_BOUND_MS + ' ms after ' + signal + ', exiting');
        process.exit(1);
      }, SHUTDOWN_BOUND_MS);
      watchdog.unref();
      server.once('close', function closed () { process.exit(0); });
      if (ctx.bootErrors && ctx.bootErrors.length > 0) server.close();
      else ctx.bus.teardown();
      server.closeIdleConnections();
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    if (ctx.bootErrors && ctx.bootErrors.length > 0) {
      return;
    }

    ctx.bus.on('teardown', function serverTeardown () {
      server.close();
      clearTimeout(sendStartupAllClearTimer);
      ctx.store.client.close();
    });

    ///////////////////////////////////////////////////
    // setup socket io for data and message transmission
    ///////////////////////////////////////////////////
    require('./websocket')(env, ctx, server);

    //after startup if there are no alarms send all clear
    let sendStartupAllClearTimer = setTimeout(function sendStartupAllClear () {
      var alarm = ctx.notifications.findHighestAlarm();
      if (!alarm) {
        ctx.bus.emit('notification', {
          clear: true
          , title: 'All Clear'
          , message: 'Server started without alarms'
        });
      }
    }, 20000);
});
