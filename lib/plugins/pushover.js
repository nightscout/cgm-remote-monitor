'use strict';

var _ = require('lodash');
var Pushover = require('pushover-notifications');
var request = require('request');
var levels = require('../levels');

var TIME_2_MINS_S = 120
  , TIME_15_MINS_S = 15 * 60
  ;

function init (env) {
  var pushover = { };
  var pushoverAPI = null;

  var apiToken = env.extendedSettings && env.extendedSettings.pushover && env.extendedSettings.pushover.apiToken;

  var userKeys = (env.extendedSettings && env.extendedSettings.pushover &&
    env.extendedSettings.pushover.userKey && env.extendedSettings.pushover.userKey.split(' ')) || [];

  var announcementKeys = (env.extendedSettings && env.extendedSettings.pushover &&
    env.extendedSettings.pushover.announcementKey && env.extendedSettings.pushover.announcementKey.split(' ')) || userKeys;

  if (apiToken && (userKeys.length > 0 || announcementKeys.length > 0)) {
    pushoverAPI = new Pushover({
      token: apiToken
    });
  }

  pushover.PRIORITY_NORMAL = 0;
  pushover.PRIORITY_EMERGENCY = 2;

  pushover.send = function wrapSend (notify, callback) {

    var selectedKeys = notify.isAnnouncement ? announcementKeys : userKeys;

    var msg = {
      expire: TIME_15_MINS_S
      , title: notify.title
      , message: notify.message
      , sound: notify.pushoverSound || 'gamelan'
      , timestamp: new Date()
      //USE PUSHOVER_EMERGENCY for WARN and URGENT so we get the acks
      , priority: notify.level >= levels.WARN ? pushover.PRIORITY_EMERGENCY : pushover.PRIORITY_NORMAL
    };

    if (levels.isAlarm(notify.level)) {
      //ADJUST RETRY TIME based on WARN or URGENT
      msg.retry = notify.level === levels.URGENT ? TIME_2_MINS_S : TIME_15_MINS_S;
      if (env.baseUrl) {
        msg.callback = env.baseUrl + '/api/v1/notifications/pushovercallback';
      }
    }

    _.forEach(selectedKeys, function eachKey(key) {
      msg.user = key;
      pushover.sendAPIRequest(msg, callback);
    });

  };

  pushover.sendAPIRequest = function sendAPIRequest (msg, callback) {
    pushoverAPI.send(msg, function (err, result) {
      if (err) {
        console.error('unable to send pushover notification', err);
      } else {
        console.info('sent pushover notification: ', msg, 'result: ', result);
      }
      callback(err, result);
    });
  };

  pushover.cancelWithReceipt = function cancelWithReceipt (receipt, callback) {
    request
      .get('https://api.pushover.net/1/receipts/' + receipt + '/cancel.json?token=' + apiToken)
      .on('response', function(response) {
        callback(null, response);
      })
      .on('error', function(err) {
        callback(err);
      });
  };

  if (pushoverAPI) {
    return pushover;
  } else {
    return null;
  }
}

module.exports = init;