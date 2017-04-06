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
var language = require('./lib/language')();
var translate = language.set(env.settings.language).translate;

///////////////////////////////////////////////////
// setup http server
///////////////////////////////////////////////////
var PORT = env.PORT;

function create (app) {
  var transport = (env.ssl
                ? require('https') : require('http'));
  if (env.ssl) {
    return transport.createServer(env.ssl, app);
  }
  return transport.createServer(app);
}

require('./lib/bootevent')(env).boot(function booted (ctx) {
    var app = require('./app')(env, ctx);
    var server = create(app).listen(PORT);
    console.log(translate('Listening on port'), PORT);

    if (env.MQTT_MONITOR) {
      ctx.mqtt = require('./lib/mqtt')(env, ctx);
      var es = require('event-stream');
      es.pipeline(ctx.mqtt.entries, ctx.entries.map( ), ctx.mqtt.every(ctx.entries));
    }

    ///////////////////////////////////////////////////
    // setup socket io for data and message transmission
    ///////////////////////////////////////////////////
    var websocket = require('./lib/websocket')(env, ctx, server);

    ctx.bus.on('data-processed', function() {
      websocket.update();
    });

    ctx.bus.on('notification', function(notify) {
      websocket.emitNotification(notify);
      if (ctx.mqtt) {
        ctx.mqtt.emitNotification(notify);
      }
    });

    //after startup if there are no alarms send all clear
    setTimeout(function sendStartupAllClear () {
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