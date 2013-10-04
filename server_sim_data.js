var test = true;
var refresh_rate = test === true ? 0.1 : 1;
var static = require('node-static');
var staticServer = new static.Server("."); //Setup static server for current directory

//Setup node http server
var server = require('http').createServer(function (request, response) {
    // Grab the URL requested by the client and parse any query options
    var url = require('url').parse(request.url, true);
    var sys = require("sys");

    // Serve file using node-static
    staticServer.serve(request, response, function (err) {
        if (err) {
            // Log the error
            sys.error("Error serving " + request.url + " - " + err.message);

            // Respond to the client
            response.writeHead(err.status, err.headers);
            response.end('Error 404 - file not found');
        }
    });

}).listen(8080);

var io = require('socket.io').listen(server);

//reload the csv file every refresh_rate minutes
var current_sensor = setInterval(function () {
    io.sockets.emit("sgv", current_sensor);
}, refresh_rate * 60 * 1000);

io.sockets.on('connection', function (socket) {
    console.log("Server connect to " + socket.id);
});