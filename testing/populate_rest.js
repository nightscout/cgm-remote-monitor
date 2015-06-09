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

main();

function main() {
    send_entry_rest();
}

function send_entry_rest() {
    var new_cgm_record = get_cgm_record();

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

function get_cgm_record() {

    var dateobj = new Date();
    var datemil = dateobj.getTime();
    var datesec = datemil / 1000;
    var datestr = getDateString(dateobj);

    // We put the time in a range from -1 to +1 for every thiry minute period
    var range = (datesec % 1800) / 900 - 1.0;

    // The we push through a COS function and scale between 40 and 400 (so it is like a bg level)
    var sgv = Math.floor(360 * (Math.cos(10.0 * range / 3.14) / 2 + 0.5)) + 40;
    var dir = range > 0.0 ? "FortyFiveDown" : "FortyFiveUp";

    console.log('Writing Record: ');
    console.log('sgv  = ' + sgv);
    console.log('date = ' + datemil);
    console.log('dir  = ' + dir);
    console.log('str  = ' + datestr);

    var doc = {
        'device': 'dexcom',
        'date': datemil,
        'sgv': sgv,
        'direction': dir,
        'dateString': datestr
    };
    return doc;
}

function getDateString(d) {

    // How I wish js had strftime. This would be one line of code!

    var month = d.getMonth();
    var day = d.getDay();
    var year = d.getFullYear();

    if (month < 10) month = '0' + month;
    if (day < 10) day = '0' + day;

    var hour = d.getHours();
    var min = d.getMinutes();
    var sec = d.getSeconds();

    var ampm = 'PM';
    if (hour < 12) {
        ampm = "AM";
    }

    if (hour == 0) {
        hour = 12;
    }
    if (hour > 12) {
        hour = hour - 12;
    }

    if (hour < 10) hour = '0' + hour;
    if (min < 10) min = '0' + min;
    if (sec < 10) sec = '0' + sec;

    return month + '/' + day + '/' + year + ' ' + hour + ':' + min + ':' + sec + ' ' + ampm;

}
