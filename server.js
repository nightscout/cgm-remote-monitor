'use strict';
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

// Description: Basic web server to display data from Dexcom G4. Requires a database that contains the Dexcom SGV data.

///////////////////////////////////////////////////
// DB Connection setup and utils
///////////////////////////////////////////////////

var env = require('./env')();

///////////////////////////////////////////////////
// Setup the HTTP-server
///////////////////////////////////////////////////
function create(app) {
    var transport = (env.ssl ? require('https') : require('http'));
    if (env.ssl) {
        return transport.createServer(env.ssl, app);
    }
    return transport.createServer(app);
}

// We need the database
var storage = require('./lib/storage')(env, function(err, store) {
    // Store the database store in the environment object
    env.store = store;

    ///////////////////////////////////////////////////
    // API and json object variables
    ///////////////////////////////////////////////////
    env.pushover = require('./pushover')(env);
    env.entries = require('./entries')(env.mongo_collection, store, env.pushover);
    env.treatments = require('./treatments')(env.treatments_collection, store, env.pushover);
    env.devicestatus = require('./devicestatus')(env.devicestatus_collection, store);
    env.profiles = require('./profile')(env.profile_collection, store);
    env.pebble = require('./pebble');

    console.info("Ensuring indexes");
    store.ensureIndexes(env.entries( ), env.entries.indexedFields);
    store.ensureIndexes(env.treatments( ), env.treatments.indexedFields);
    store.ensureIndexes(env.devicestatus( ), env.devicestatus.indexedFields);
    store.ensureIndexes(env.profiles( ), env.profiles.indexedFields);

    var app = require('./app')(env, ctx);
    var server = create(app).listen(env.PORT);

    console.log('Listening on port ', env.PORT);

    if (env.MQTT_MONITOR) {
        var mqtt = require('./lib/mqtt')(env, app.entries, app.devicestatus);
        var es = require('event-stream');
        es.pipeline(mqtt.entries, app.entries.map(), mqtt.every(app.entries));
    }

    ///////////////////////////////////////////////////
    // setup socket io for data and message transmission
    ///////////////////////////////////////////////////
    var websocket = require('./lib/websocket');
    websocket(env, server, app.entries, app.treatments, app.profiles, app.devicestatus);
});

///////////////////////////////////////////////////
