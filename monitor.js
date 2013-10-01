//basic web server to display data from Dexcom G4
//requires a small program which sits on the 
//Dexcom Studio DLL and creates a CSV file
//this program reads the csv file, parses it, then
//acts as a web server to display the current value
var test = true;
var refresh_rate = test === true ? 0.1 : 1;
var http = require("http");
var app = require("express");
var sys = require("sys");
var fs = require('fs');
var moment = require('moment');
var nodestatic = require('node-static');
var staticServer = new nodestatic.Server("."); //Setup static server for current directory
var exec = require('child_process').exec,
    child;

//initialize to yesterday
var last_acknowledge_datetime = moment().subtract('days', 1);

//delete old data file
fs.unlink('sgv3.json', function (err) {
    console.log('successfully deleted sgv3.json');
});

//Setup node http server
var server = require('http').createServer(function (request, response) {
    // Grab the URL requested by the client and parse any query options
    var url = require('url').parse(request.url, true);
    var pathfile = url.pathname;
    //console.log(url, pathfile);
    var query = url.query;

    // Print requested file to terminal
    //console.log('Request from '+ request.connection.remoteAddress +' for: ' + pathfile);

    // Serve file using node-static			
    staticServer.serve(request, response, function (err, result) {
        if (err) {
            // Log the error
            sys.error("Error serving " + request.url + " - " + err.message);

            // Respond to the client
            response.writeHead(err.status, err.headers);
            response.end('Error 404 - file not found');
            return;
        }
        return;
    })

});
var io = require('socket.io').listen(server);
var fs = require('fs');
server.listen(3000);

clearInterval(current_sensor);

//reload the csv file every refresh_rate minutes
var current_sensor = setInterval(function () {

    fs.readFile('Dexcom.csv', 'utf-8', function (err, data) {
        if (!err) {
            // parse the csv file into lines
            var lines = data.trim().split('\n');
            var latest = lines.length - 1;

            for (var i = 0; i <= latest; i++) {
                if (!lines[i])
                    lines.splice(i, 1);
                else
                    lines[i] = lines[i].split(",");
            }

            var sbgs = new Array(lines.length);
            var timestamps = new moment(Array(lines.length));
            for (i = 0; i <= latest; i++) {
                sbgs[i] = lines[i][1];
                timestamps[i] = moment(lines[i][10], 'MM/DD/YYYY hh:mm:ss A');
                console.log(lines[i][10]);
            }

            var GMTdatetime = moment();
            var historylength = 72;
            var data2 = new Array(historylength);

            for (i = 0; i <= historylength; i++) {
                GMTdatetime = timestamps[i - historylength + latest];
                //GMTdatetime = GMTdatetime.add('hours', GMTdatetime.zone()/60);
                data2[i] = {
                    datetime: GMTdatetime,
                    sgv: sbgs.map(function (x) {
                        return parseInt(x)
                    })[i - historylength + latest],
                    status: 'gray'
                };
            }

            var data2_len = data2.length - 1;

            var elapsed_min = (data2[data2_len].datetime - data2[data2_len - 1].datetime) / 60000

            //recursively predict using AR model
            var reference_bg = 140; //

            var y = Math.log(data2[data2_len].sgv / reference_bg);

            if (elapsed_min < 5.1) {
                y = [y, Math.log(data2[data2_len].sgv / reference_bg)]
            } else {
                y = [y, y]
            };

            var n = 4 * 12 //predict 4 hours ahead
            var AR = [-0.723, 1.716];
            var dt = moment(data2[data2_len].datetime);
            for (i = 0; i <= n; i++) {
                y = [y[1], AR[0] * y[0] + AR[1] * y[1]];
                dt = moment.unix(dt.unix() + 60 * 5)
                data2[i + data2_len + 1] = {
                    datetime: dt,
                    sgv: Math.round(reference_bg * Math.exp(y[1])),
                    status: 'blue'
                };
            }

            data2_len = data2_len + n;

            var outputFilename = 'sgv3.json';
            fs.writeFile(outputFilename, JSON.stringify(data2, null, 4), function (err) {
                if (err) {
                    console.log(err);
                } else { 
                    console.log("JSON saved to " + outputFilename);
                }
            });
            current_sensor = JSON.stringify(data2, null, 4);
            console.log(current_sensor)
			io.sockets.emit("sgv", current_sensor);
        }
    });

}, refresh_rate * 60 * 1000);

io.sockets.on('connection', function (socket) {
    console.log(current_sensor)
    //socket.emit('sgv', current_sensor);
    socket.emit('last_acknowledge_datetime', JSON.stringify(last_acknowledge_datetime.valueOf()));
    socket.on('acknowledged', function (data) {
        last_acknowledge_datetime = moment(data);
        console.log("alarm acknowledged: ", last_acknowledge_datetime.format("LLL"));
        socket.emit('last_acknowledge_datetime', 1);
    });
});