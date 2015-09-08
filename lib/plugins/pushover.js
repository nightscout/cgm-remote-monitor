'use strict';

var _ = require('lodash');
var Pushover = require('pushover-notifications');
var request = require('request');
var levels = require('../levels');
var times = require('../times');

function init (env) {
  var pushover = {
    PRIORITY_NORMAL: 0
    , PRIORITY_EMERGENCY: 2
  };

  var pushoverAPI = setupPushover(env);

  pushover.send = function wrapSend(notify, callback) {
    var selectedKeys = notify.isAnnouncement ? pushoverAPI.announcementKeys : pushoverAPI.userKeys;

    var msg = {
      expire: times.mins(15).secs
      , title: notify.title
      , message: notify.message
      , sound: notify.pushoverSound || 'gamelan'
      , timestamp: new Date()
      //USE PUSHOVER_EMERGENCY for WARN and URGENT so we get the acks
      , priority: notify.level >= levels.WARN ? pushover.PRIORITY_EMERGENCY : pushover.PRIORITY_NORMAL
    };

    if (levels.isAlarm(notify.level)) {
      //ADJUST RETRY TIME based on WARN or URGENT
      msg.retry = notify.level === levels.URGENT ? times.mins(2).secs : times.mins(15).secs;
      if (env.baseUrl) {
        msg.callback = env.baseUrl + '/api/v1/notifications/pushovercallback';
      }
    }

    _.each(selectedKeys, function eachKey(key) {
      msg.user = key;
      pushover.sendAPIRequest(msg, callback);
    });

  };

  pushover.sendAPIRequest = function sendAPIRequest (msg, callback) {
    pushoverAPI.send(msg, function response (err, result) {
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
      .get('https://api.pushover.net/1/receipts/' + receipt + '/cancel.json?token=' + pushoverAPI.apiToken)
      .on('response', function (response) {
        callback(null, response);
      })
      .on('error', function (err) {
        callback(err);
      });
  };

  if (pushoverAPI) {
    console.info('Pushover is ready to push');
    return pushover;
  } else {
    console.info('Pushover was NOT configured');
    return null;
  }
}

function setupPushover (env) {
  var apiToken = env.extendedSettings && env.extendedSettings.pushover && env.extendedSettings.pushover.apiToken;

  var userKeys = (env.extendedSettings && env.extendedSettings.pushover &&
    env.extendedSettings.pushover.userKey && env.extendedSettings.pushover.userKey.split(' ')) || [];

  if (userKeys.length === 0) {
    userKeys = (env.extendedSettings && env.extendedSettings.pushover &&
      env.extendedSettings.pushover.groupKey && env.extendedSettings.pushover.groupKey.split(' ')) || [];
  }

  var announcementKeys = (env.extendedSettings && env.extendedSettings.pushover &&
    env.extendedSettings.pushover.announcementKey && env.extendedSettings.pushover.announcementKey.split(' ')) || userKeys;

  if (apiToken && (userKeys.length > 0 || announcementKeys.length > 0)) {
    var pushoverAPI = new Pushover({
      token: apiToken
    });

    pushoverAPI.apiToken = apiToken;
    pushoverAPI.userKeys = userKeys;
    pushoverAPI.announcementKeys = announcementKeys;

    return pushoverAPI;
  }
}


module.exports = init;