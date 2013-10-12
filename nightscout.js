//basic web server to display data from Dexcom G4
//requires a small program which sits on the 
//Dexcom Studio DLL and creates a CSV file
//this program reads the csv file, parses it, then
//acts as a web server to display the current value
//Taken from Lane D.
var bgData = [];
var test = true;
var refresh_rate = (test === true ? 0.1 : 1) * 60 * 1000;
var nodeStatic = require('node-static');
var fs = require('fs');
var staticServer = new nodeStatic.Server(".");

//Setup node http server
var server = require('http').createServer(function serverCreator(request, response) {
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
}).listen(3000);

//Setup socket io for data and message transmission
var io = require('socket.io').listen(server);

var historyLength = 12 * 3;

var clients = [];

//Initialize last ACK to 1 hour ago
var lastAckTime = Date.now() - 3600000;

//Reload the csv file every refresh_rate minutes
function update() {

    fs.readFile('Dexcom.csv', 'utf-8', function fileReader(error, data) {
        if (error) {
            console.log("Error reading csv file.");
        } else {
            // parse the csv file into lines
            var lines = data.trim().split('\n');
            var latest = lines.length - 1;
            var actual = [];

            for (var i = latest; i > latest - historyLength; i--) {
                lines[i] = lines[i].split(",");
                actual.unshift({x: new Date(lines[i][10]).getTime(), y: lines[i][1]});
    }

            //Predict using AR model
            var predicted = [];
            var actual_len = actual.length - 1;
            var lastValidReadingTime = actual[actual_len].x;
            var elapsed_min = (actual[actual_len].x - actual[actual_len].x) / 60000;
            var BG_REF = 100;
            var y = Math.log(actual[actual_len].y / BG_REF);

            if (elapsed_min < 5.1) {
                y = [y, Math.log(actual[actual_len].y / BG_REF)];
            } else {
                y = [y, y];
            }

            var n = 12 * 4;                             //Predict 4 hour ahead
            var AR = [-0.723, 1.716];                   //AR calculation constants
            var dt = actual[actual_len].x;
            for (i = 0; i <= n; i++) {
                y = [y[1], AR[0] * y[0] + AR[1] * y[1]];
                dt = dt + 5 * 60 * 1000;
                predicted[i] = {
                    x: dt,
                    y: Math.round(BG_REF * Math.exp(y[1]))
                };
            }

            //Remove measured points that don't lie within the time range
            while(actual.length > 0 && actual[0].x < Date.now() - historyLength * 5 * 60 * 1000) { actual.shift(); }
            while(predicted.length > 0 && predicted[0].x < Date.now() - n * 5 * 60 * 1000) { predicted.shift(); }

            bgData = [actual, predicted];
            io.sockets.emit("sgv", bgData);
            console.log("Sending SGV data to clients.");

            var now = Date.now();
            var avgLost = 0;
            if (now > lastAckTime + 2400000) {
                for (i = 0; i <= 6; i++ ) {
                    data = predicted;
                    avgLost += 1/6 * Math.pow(log10(data[i].y / 120), 2);
                }
                console.log("The average loss is: " + avgLost);
                if (avgLost > 0.2) {
                    io.sockets.emit('urgent_alarm');
                } else if (avgLost > 0.05) {
                    io.sockets.emit('alarm');
                }
            }
        }
    });
}

var sensorReadID = setInterval(update, refresh_rate);

io.sockets.on('connection', function (socket) {
    socket.emit("sgv", bgData);
    socket.on('update', function (data) {
        console.log("updating time scale to " + data + " hours");
        historyLength = data * 12;
        update();
    });
    socket.on('ack', function(time) { lastAckTime = time; })
});

function log10(val) { return Math.log(val) / Math.LN10; }