'use strict';

var _ = require('lodash');
var crypto = require('crypto');
var units = require('./units')();
var NodeCache = require( "node-cache" );

function init(env, ctx) {

  var pushover = require('./pushover')(env);

  // declare local constants for time differences
  var TIME_15_MINS_S = 15 * 60
    , TIME_15_MINS_MS = TIME_15_MINS_S * 1000
    ;

  function pushnotify() {
    return pushnotify;
  }

  var recentlySent = new NodeCache({ stdTTL: TIME_15_MINS_MS, checkperiod: 20 });

  pushnotify.emitNotification = function emitNotification (notify) {
    if (!pushover) return;

    var key = null;
    if (notify.level >= ctx.notifications.levels.WARN) {
      //for WARN and higher use the plugin name and notification level so that louder alarms aren't triggered too often
      key = notify.plugin.name + '_' + notify.level;
    } else {
      //INFO and lower notifications should be sent as long as they are different
      key = notifyToHash(notify);
    }

    if (recentlySent.get(key)) {
      console.info('notify: ' + key + ' has ALREADY been sent');
      return;
    }

    var msg = {
      expire: TIME_15_MINS_S,
      title: notify.title,
      message: notify.message,
      sound: notify.pushoverSound || 'gamelan',
      timestamp: new Date( ),
      priority: notify.level,
      retry: 30
    };

    //add the key to the cache before sending, but with a short TTL
    recentlySent.set(key, notify, 30);
    pushover.send(msg, function(err, result) {
      if (err) {
        console.error('unable to send pushover notification', err);
      } else {
        //after successfully sent, increase the TTL
        recentlySent.ttl(key, TIME_15_MINS_S);
        console.info('sent pushover notification: ', msg, 'result: ', result);
      }
    });

  };

  function notifyToHash(notify) {
    var hash = crypto.createHash('sha1');
    var info = JSON.stringify(_.pick(notify, ['title', 'message']));
    hash.update(info);
    return hash.digest('hex');
  }

  return pushnotify();
}


module.exports = init;