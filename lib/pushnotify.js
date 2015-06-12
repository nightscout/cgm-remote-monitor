'use strict';

var _ = require('lodash');
var crypto = require('crypto');
var units = require('./units')();

function init(env, ctx) {

  var pushover = require('./pushover')(env);

  // declare local constants for time differences
  var TIME_5_MINS_MS = 5 * 60 * 1000
    ,TIME_15_MINS_S = 15 * 60
    , TIME_15_MINS_MS = TIME_15_MINS_S * 1000
    ;

  function pushnotify() {
    return pushnotify;
  }

  var recentlySent = {};

  pushnotify.emitNotification = function emitNotification (notify) {
    if (!pushover) return;

    if (isDuplicate(notify)) return;

    var msg = {
      expire: TIME_15_MINS_S,
      title: notify.title,
      message: notify.message,
      sound: notify.pushoverSound || 'gamelan',
      timestamp: new Date( ),
      priority: notify.level,
      retry: 30
    };

    pushover.send(msg, function(err, result) {
      updateRecentlySent(err, notify);
      if (err) {
        console.error('unable to send pushover notification', err);
      } else {
        console.info('sent pushover notification: ', msg, 'result: ', result);
      }
    });

  };

  function isDuplicate(notify) {
    var byLevel = sentByLevel(notify);
    var hash = notifyToHash(notify);

    var found = _.find(byLevel, function findByHash(sent) {
      return sent.hash = hash;
    });

    if (found) {
      console.info('Found duplicate notification that was sent recently using hash: ', hash, 'of notify: ', notify);
      return true;
    } else {
      console.info('No duplicate notification found, using hash: ', hash, 'of notify: ', notify);
      return false;
    }

  }

  function updateRecentlySent(err, notify) {
    sentByLevel(notify).push({
      time: Date.now()
      , err: err
      , hash: notifyToHash(notify)
    });
  }

  function sentByLevel(notify) {
    var byLevel = recentlySent[notify.level];
    if (!byLevel) {
      byLevel = [];
    }

    var now = Date.now();

    byLevel = _.filter(byLevel, function isRecent(sent) {
      //consider errors stale sooner than successful sends
      var staleAfter = sent.err ? TIME_5_MINS_MS : TIME_15_MINS_MS;
      return now - sent.time < staleAfter;
    });

    recentlySent[notify.level] = byLevel;

    return byLevel;
  }

  function notifyToHash(notify) {
    var hash = crypto.createHash('sha1');
    var info = JSON.stringify(_.pick(notify, ['title', 'message']));
    hash.update(info);
    return hash.digest('hex');
  }

  return pushnotify();
}


module.exports = init;