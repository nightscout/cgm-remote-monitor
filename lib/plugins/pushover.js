'use strict';

var Pushover = require('pushover-notifications');
var request = require('request');

function init (env) {
  var pushover = null;

  if (env.pushover_api_token && env.pushover_user_key) {
    pushover = new Pushover({
      token: env.pushover_api_token,
      user: env.pushover_user_key
    });

    pushover.PRIORITY_NORMAL = 0;
    pushover.PRIORITY_EMERGENCY = 2;

    pushover.cancelWithReceipt = function cancelWithReceipt (receipt, callback) {
      request
        .get('https://api.pushover.net/1/receipts/' + receipt + '/cancel.json?token=' + env.pushover_api_token)
        .on('response', function(response) {
          callback(null, response);
        })
        .on('error', function(err) {
          callback(err);
        });
    };
  }

  return pushover;
}

module.exports = init;