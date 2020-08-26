'use strict';

var env = require('./../env')();
var http = require('http');
var util = require('./util');

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
    console.log('Ok: ', res.statusCode);
  });

  req.on('error', function(e) {
    console.error('error');
    console.error(e);
  });

  req.write(new_cgm_record_string);
  req.end();
}