'use strict';

var _ = require('lodash');
var Pushover = require('pushover-notifications');
var request = require('request');
var times = require('../times');

function init (env, ctx) {
  var pushover = {
    PRIORITY_NORMAL: 0
    , PRIORITY_EMERGENCY: 2
  };

  var pushoverAPI = setupPushover(env);

  function selectKeys (notify) {
    var keys = null;

    if (notify.isAnnouncement) {
      keys = pushoverAPI.announcementKeys;
    } else if (ctx.levels.isAlarm(notify.level)) {
      keys = pushoverAPI.alarmKeys;
    } else {
      keys = pushoverAPI.userKeys;
    }

    return keys;
  }

  pushover.send = function wrapSend (notify, callback) {
    var selectedKeys = selectKeys(notify);

    function prepareMessage() {
      var msg = {
        expire: times.mins(15).secs
        , title: notify.title
        , message: notify.message
        , sound: notify.pushoverSound || 'gamelan'
        , timestamp: new Date()
        //USE PUSHOVER_EMERGENCY for WARN and URGENT so we get the acks
        , priority: notify.level >= ctx.levels.WARN ? pushover.PRIORITY_EMERGENCY : pushover.PRIORITY_NORMAL
      };

      if (ctx.levels.isAlarm(notify.level)) {
        //ADJUST RETRY TIME based on WARN or URGENT
        msg.retry = notify.level === ctx.levels.URGENT ? times.mins(2).secs : times.mins(15).secs;
        if (env.settings && env.settings.baseURL) {
          msg.callback = env.settings.baseURL + '/api/v1/notifications/pushovercallback';
        }
      }
      return msg;
    }

    if (selectedKeys.length === 0) {
      if (callback) {
        return callback('no-key-defined');
      }
    }

    var msg = prepareMessage();

    _.each(selectedKeys, function eachKey(key) {
      msg.user = key;
      pushover.sendAPIRequest(msg, callback);
    });

  };

  pushover.sendAPIRequest = function sendAPIRequest (msg, callback) {
    pushoverAPI.send(msg, function response (err, result) {
      if (err) {
        console.error('unable to send pushover notification', msg, err);
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

  function keysByType (type, fallback) {
    fallback = fallback || [];

    var key = env.extendedSettings && env.extendedSettings.pushover && env.extendedSettings.pushover[type];

    if (key === false) {
      return [];  //don't consider fallback, this type has been disabled
    } else if (key && key.split) {
      return key.split(' ') || fallback;
    } else {
      return fallback;
    }
  }

  var userKeys = keysByType('userKey', []);

  if (userKeys.length === 0) {
    userKeys = keysByType('groupKey') || [];
  }

  var alarmKeys = keysByType('alarmKey', userKeys);

  var announcementKeys = keysByType('announcementKey', userKeys || alarmKeys);

  if (apiToken && (userKeys.length > 0 || alarmKeys.length > 0 || announcementKeys.length > 0)) {
    var pushoverAPI = new Pushover({
      token: apiToken,
      onerror: function(error) {
        console.error('Pushover error', error);
      }
    });

    pushoverAPI.apiToken = apiToken;
    pushoverAPI.userKeys = userKeys;
    pushoverAPI.alarmKeys = alarmKeys;
    pushoverAPI.announcementKeys = announcementKeys;

    return pushoverAPI;
  }
}


module.exports = init;