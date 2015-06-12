'use strict';
///////////////////////////////////////////////////
// This script is intended to be run as a cron job
// every n-minutes or whatever the equiv is on windows
//
// Author: John A. [euclidjda](https://github.com/euclidjda)
// Source: https://gist.github.com/euclidjda/4ae207a89921f21382a9
///////////////////////////////////////////////////

///////////////////////////////////////////////////
// DB Connection setup and utils
///////////////////////////////////////////////////

var software = require('./../package.json');
var env = require('./../env')();
var http = require('http');
var util = require('./helpers/util');

main();

function main() {
    send_entry_rest();
}

function send_entry_rest() {
    var new_cgm_record = util.get_cgm_record();
    var new_cgm_record_string = JSON.stringify(new_cgm_record);

    var options = {
        host: 'localhost',
        port: env.PORT,
        path: '/api/v1/entries/',
        method: 'POST',
        headers: {
            'api-secret' : env.api_secret,
            'Content-Type': 'application/json',
            'Content-Length': new_cgm_record_string.length
        }
    };

    var req = http.request(options, function(res) {
        console.log("Ok: ", res.statusCode);
    });

    req.on('error', function(e) {
        console.error('error');
        console.error(e);
    });

    req.write(new_cgm_record_string);
    req.end();
}
