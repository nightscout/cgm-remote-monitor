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

////////////////////////////////////////////////////////////////////////////////////////////////////
// local variables
////////////////////////////////////////////////////////////////////////////////////////////////////
var patientData = [];
var now = new Date().getTime();
var fs = require('fs');
var mongoClient = require('mongodb').MongoClient;
var cgmData = [];
////////////////////////////////////////////////////////////////////////////////////////////////////

////////////////////////////////////////////////////////////////////////////////////////////////////
// setup http server
////////////////////////////////////////////////////////////////////////////////////////////////////
var PORT = process.env.PORT || 1337;
var server = require('http').createServer(function serverCreator(request, response) {
    var nodeStatic = require('node-static');
    var staticServer = new nodeStatic.Server(".");
    var sys = require("sys");
    // Grab the URL requested by the client and parse any query options
    var url = require('url').parse(request.url, true);

    // Serve file using node-static
    staticServer.serve(request, response, function clientHandler(err) {
        if (err) {
            // Log the error
            sys.error("Error serving " + request.url + " - " + err.message);

            // Respond to the client
            response.writeHead(err.status, err.headers);
            response.end('Error 404 - file not found');
        }
    });
}).listen(PORT);
////////////////////////////////////////////////////////////////////////////////////////////////////

////////////////////////////////////////////////////////////////////////////////////////////////////
// setup socket io for data and message transmission
////////////////////////////////////////////////////////////////////////////////////////////////////
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
    socket.on('ack', function(time) {
        lastAckTime = new Date().getTime();
        io.sockets.emit("clear_alarm", true);
        console.log("alarm cleared");
    });
    socket.on('disconnect', function () {
        io.sockets.emit("clients", --watchers);
    });
});
////////////////////////////////////////////////////////////////////////////////////////////////////

////////////////////////////////////////////////////////////////////////////////////////////////////
// data handling functions
////////////////////////////////////////////////////////////////////////////////////////////////////
var lastAckTime = 0;
var TZ_OFFSET_PATIENT = 8;
var TZ_OFFSET_SERVER = new Date().getTimezoneOffset() / 60;
var ONE_HOUR = 3600000;
var ONE_MINUTE = 60000;
var FIVE_MINUTES = 300000;
var FORTY_MINUTES = 2400000;
var TWO_DAYS = 172800000;
var DB = require('./database_configuration.json');
var DB_URL = DB.url;
var DB_COLLECTION = DB.collection;

function update() {

    now = Date.now();

    cgmData = [];
    var earliest_data = now - TWO_DAYS;
    mongoClient.connect(DB_URL, function (err, db) {
        if (err) throw err;
        var collection = db.collection(DB_COLLECTION);

        collection.find({"date": {"$gte": earliest_data}}).toArray(function(err, results) {
            results.forEach(function(element, index, array) {
                if (element) {
                    var obj = {};
                    obj.y = element.sgv;
                    obj.x = element.date;
                    obj.d = element.dateString;
                    cgmData.push(obj);
                }
            });
            db.close();
        });
    });

    // wait for database read to complete, 5 secs has proven to be more than enough
    setTimeout(loadData, 5000);

    return update;
}

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
        if (now > lastAckTime + FORTY_MINUTES) {
            for (i = 0; i <= 6; i++) {
                avgLoss += 1 / 6 * Math.pow(log10(predicted[i].y / 120), 2);
            }
            if (avgLoss > 0.10) {
                io.sockets.emit('urgent_alarm');
            } else if (avgLoss > 0.05) {
                io.sockets.emit('alarm');
            }
        }
    }
}

// get data from database and setup to update every minute
setInterval(update(), ONE_MINUTE);

////////////////////////////////////////////////////////////////////////////////////////////////////

////////////////////////////////////////////////////////////////////////////////////////////////////
// helper functions
////////////////////////////////////////////////////////////////////////////////////////////////////

function log10(val) { return Math.log(val) / Math.LN10; }

////////////////////////////////////////////////////////////////////////////////////////////////////
