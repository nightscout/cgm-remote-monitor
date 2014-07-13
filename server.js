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

///////////////////////////////////////////////////
// DB Connection setup and utils
///////////////////////////////////////////////////

var env = require('./env')( );
var package = require('./package.json');
var store = require('./lib/storage')(env);
var pebble = require('./lib/pebble');
var mongoClient = require('mongodb').MongoClient;
var DEFAULT_SETTINGS_JSON = {
        "units": "mg/dl"
}; // possible future settings: "theme": "subdued", "websockets": false

//console.log(env.mongo_collection);
//console.log(env.settings_collection);

// Initialize the collection by creating it (if it does not exist) and optionally populate it with initial data.
function initCollection(name, document) {
    mongoClient.connect(env.mongo, function (err, db) {
        if (err) throw err;
        console.log("Initializing collection: "+ name);

        // Create the collection, this will not overwrite the existing collection.
        db.createCollection(name, function(err, collection, name, next) {
            if (err) next();
        });

        // Populate the default data when present.
        if (document) {
            var collection = db.collection(name);
            collection.count(function(err, count) {
                if (!err && count === 0) {
                    // Populate the collection with the supplied document.
                    console.log('Populate ' + name + ' with ' + JSON.stringify(document));
                    db.collection(name).insert(document, function(err, records) {
                    if (err) throw err;
                        console.log("Record added as "+records[0]._id);
                    });
                }
            });
        }
    });
}

function with_collection(name) {
    return function(fn) {
        mongoClient.connect(env.mongo, function (err, db) {
            if (err) {
                fn(err, null);
            } else {
                var collection = db.collection(name);
                fn(null, collection);
            }
        });
    };
}

function with_entries_collection() {
    // initCollection(env.mongo_collection);
    return with_collection(env.mongo_collection);
}

function with_settings_collection() {
    // initCollection(env.settings_collection, DEFAULT_SETTINGS_JSON);
    return with_collection(env.settings_collection);
}

///////////////////////////////////////////////////
// local variables
///////////////////////////////////////////////////
var express = require('express');

///////////////////////////////////////////////////
// api and json object variables
///////////////////////////////////////////////////
var entries = require('./lib/entries');
var settings = require('./lib/settings');
var api = require('./lib/api')(env, entries, settings, with_entries_collection(), with_settings_collection());
///////////////////////////////////////////////////

///////////////////////////////////////////////////
// setup http server
///////////////////////////////////////////////////
var PORT = env.PORT;
var THIRTY_DAYS = 2592000;
var now = new Date();

var app = express();
var appInfo = package.name + ' ' + package.version;
app.set('title', appInfo);
app.enable('trust proxy'); // Allows req.secure test on heroku https connections.

// Only allow access to the API if API_SECRET is set on the server.
if (env.api_secret) {
    console.log("API_SECRET", env.api_secret);
    
    // Display an error when you're not using SSL.
    app.use('/api/v1', requireSSL);
    
    // Handle API requests.
    app.use('/api/v1', api); 
}

// pebble data
app.get('/pebble', servePebble);

// define static server
var staticFiles = express.static(env.static_files, {maxAge: THIRTY_DAYS * 1000});

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
  var io = websocket(env, server, store);
});

///////////////////////////////////////////////////
// server helper functions
///////////////////////////////////////////////////
function requireSSL(req, res, next) {
    // Are we currently secure?
    var secure = req.secure;
    
    // If we are not secure display a warming. message.
    if (secure === false) {
        // Define the user to the Secure version of the current URL.
        var secureUrl = 'https://' + req.hostname + req.baseUrl + req.url;
        console.log('WARNING: To encrypt your data, please use ' + secureUrl + '.');
        next(); //res.status(401).send('<h1>HTTPS Required.</h1>SSL ecryption is required to secure your data. ( Use this URL instead: ' + secureUrl + ' )');
    } else {
        next();
    }

}

function servePebble(req, res) {
    req.with_entries = store.with_collection(env.mongo_collection);
    pebble.pebble(req, res);
    return;
}
///////////////////////////////////////////////////
/*
var io = require('socket.io').listen(server);

// reduce logging
io.set('log level', 0);

//Windows Azure Web Sites does not currently support WebSockets, so use long-polling
io.configure(function () {
    io.set('transports', ['xhr-polling']);
});

var watchers = 0;
io.sockets.on('connection', function (socket) {
    io.sockets.emit("now", now);
    io.sockets.emit("sgv", patientData);
    io.sockets.emit("clients", ++watchers);
    socket.on('ack', function(alarmType, _silenceTime) {
        alarms[alarmType].lastAckTime = new Date().getTime();
        alarms[alarmType].silenceTime = _silenceTime ? _silenceTime : FORTY_MINUTES;
        io.sockets.emit("clear_alarm", true);
        console.log("alarm cleared");
    });
    socket.on('disconnect', function () {
        io.sockets.emit("clients", --watchers);
    });
});
///////////////////////////////////////////////////

///////////////////////////////////////////////////
// data handling functions
///////////////////////////////////////////////////

var ONE_HOUR = 3600000,
    ONE_MINUTE = 60000,
    FIVE_MINUTES = 300000,
    FORTY_MINUTES = 2400000,
    TWO_DAYS = 172800000;

var dir2Char = {
  'NONE': '&#8700;',
  'DoubleUp': '&#8648;',
  'SingleUp': '&#8593;',
  'FortyFiveUp': '&#8599;',
  'Flat': '&#8594;',
  'FortyFiveDown': '&#8600;',
  'SingleDown': '&#8595;',
  'DoubleDown': '&#8650;',
  'NOT COMPUTABLE': '-',
  'RATE OUT OF RANGE': '&#8622;'
};

function directionToChar(direction) {
  return dir2Char[direction] || '-';
}

var Alarm = function(_typeName, _threshold) {
    this.typeName = _typeName;
    this.silenceTime = FORTY_MINUTES;
    this.lastAckTime = 0;
    this.threshold = _threshold;
};

// list of alarms with their thresholds
var alarms = {
    "alarm" : new Alarm("Regular", 0.05),
    "urgent_alarm": new Alarm("Urgent", 0.10)
};

function update() {

    now = Date.now();

    cgmData = [];
    var earliest_data = now - TWO_DAYS;
    store(function ( ) {
      var collection = store.collection(env.mongo_collection);

      collection.find({"date": {"$gte": earliest_data}}).toArray(function(err, results) {
          results.forEach(function(element, index, array) {
              if (element) {
                  var obj = {};
                  obj.y = element.sgv;
                  obj.x = element.date;
                  obj.d = element.dateString;
                  obj.direction = directionToChar(element.direction);
                  cgmData.push(obj);
              }
          });
          // all done, do loadData
          loadData( );
      });
    });

    return update;
}

function emitAlarm(alarmType) {
    var alarm = alarms[alarmType];
    if (now > alarm.lastAckTime + alarm.silenceTime) {
        io.sockets.emit(alarmType);
    } else {
        console.log(alarm.typeName + " alarm is silenced for " + Math.floor((alarm.silenceTime - (now - alarm.lastAckTime)) / 60000) + " minutes more");
    }
}

*/
/*
function loadData() {

    var treatment = [];
    var mbg = [];

    var actual = [];
    if (cgmData) {
        actual = cgmData.slice();
        actual.sort(function(a, b) {
            return a.x - b.x;
        });
        
        // sgv less than or equal to 10 means error code
        // or warm up period code, so ignore
        actual = actual.filter(function (a) {
            return a.y > 10;
        })
    }

    var actualLength = actual.length - 1;

    if (actualLength > 1) {
        // predict using AR model
        var predicted = [];
        var lastValidReadingTime = actual[actualLength].x;
        var elapsedMins = (actual[actualLength].x - actual[actualLength - 1].x) / ONE_MINUTE;
        var BG_REF = 140;
        var BG_MIN = 36;
        var BG_MAX = 400;
        var y = Math.log(actual[actualLength].y / BG_REF);
        if (elapsedMins < 5.1) {
            y = [Math.log(actual[actualLength - 1].y / BG_REF), y];
        } else {
            y = [y, y];
        }
        var n = Math.ceil(12 * (1 / 2 + (now - lastValidReadingTime) / ONE_HOUR));
        var AR = [-0.723, 1.716];
        var dt = actual[actualLength].x;
        for (i = 0; i <= n; i++) {
            y = [y[1], AR[0] * y[0] + AR[1] * y[1]];
            dt = dt + FIVE_MINUTES;
            predicted[i] = {
                x: dt,
                y: Math.max(BG_MIN, Math.min(BG_MAX, Math.round(BG_REF * Math.exp(y[1]))))
            };
        }

        //TODO: need to consider when data being sent has less than the 2 day minimum

        // consolidate and send the data to the client
        patientData = [actual, predicted, mbg, treatment];
        io.sockets.emit("now", now);
        io.sockets.emit("sgv", patientData);

        // compute current loss
        var avgLoss = 0;
        var size = Math.min(predicted.length - 1, 6);
        for (var j = 0; j <= size; j++) {
            avgLoss += 1 / size * Math.pow(log10(predicted[j].y / 120), 2);
        }

        if (avgLoss > alarms['urgent_alarm'].threshold) {
            emitAlarm('urgent_alarm');
        } else if (avgLoss > alarms['alarm'].threshold) {
            emitAlarm('alarm');
        }
    }
}

// get data from database and setup to update every minute
function kickstart ( ) {
  //TODO: test server to see how data is stored (timestamps, entry values, etc)
  //TODO: check server settings to configure alerts, entry units, etc
  update( );
  return update;
}
setInterval(kickstart(), ONE_MINUTE);

///////////////////////////////////////////////////

*/

///////////////////////////////////////////////////
