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
// Check Node version. We only allow secure LTS versions of Node
// < 8        does not work, not supported
// >= 8.14.0  works, supported and recommended
// == 8.11.1  works, not fully supported (latest Azure node; INSECURE)
// == 9.x     does not work, not supported
// >= 10.14.2 works, not recommended yet, will be supported with Nightscout >= 0.12
// >= 11.4.0  works, not recommended yet
///////////////////////////////////////////////////
const semver = require('semver')
var nodeVersion = process.version;
if (semver.satisfies(nodeVersion, '^8.14.0')) { // Lates Node 8 LTS is supported and recommended for Nightscout
  console.info('Your Node version ' + nodeVersion + ' is supported and recommended for Nightscout') ;
} else {
  var major = semver.major(nodeVersion); // major part of the Node version number
  var dontStart = (major === 8 && (!semver.satisfies(nodeVersion, '^8.14.0')) && (!semver.eq(nodeVersion, '8.11.1')))
    || major<8 || major === 9 || (major === 10 && semver.lt(nodeVersion, '10.14.2'))
    || (major === 11 && semver.lt(nodeVersion, '11.4.0'));
  if (dontStart) { // only start on secure versions (and allow Azure version)
    console.error('Node version '+ nodeVersion +' is not supported. cgm-remote-monitor requires Node 8 LTS (>= 8.14.0)');
    process.exit(1)
  }
  if (semver.eq(nodeVersion, '8.11.1')) {
    console.warn('Node version v8.11.1 and Microsoft Azure are not recommended. Please migrate to another hosting provider.');
    console.warn('Your Node version is considered insecure and has several vulnerabilities. Use at your own risk.');
  } else if (semver.satisfies(nodeVersion, '>=10')) {
    console.warn('Node ' + nodeVersion + ' is NOT recommended and may cause problems. Please use Node 8 LTS') ;
  }
}

///////////////////////////////////////////////////
// setup http server
///////////////////////////////////////////////////
var PORT = env.PORT;
var HOSTNAME = env.HOSTNAME;

function create (app) {
  var transport = (env.ssl
                ? require('https') : require('http'));
  if (env.ssl) {
    return transport.createServer(env.ssl, app);
  }
  return transport.createServer(app);
}

require('./lib/server/bootevent')(env, language).boot(function booted (ctx) {
    var app = require('./app')(env, ctx);
    var server = create(app).listen(PORT, HOSTNAME);
    console.log(translate('Listening on port'), PORT, HOSTNAME);

    if (ctx.bootErrors && ctx.bootErrors.length > 0) {
      return;
    }

    ///////////////////////////////////////////////////
    // setup socket io for data and message transmission
    ///////////////////////////////////////////////////
    var websocket = require('./lib/server/websocket')(env, ctx, server);

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
