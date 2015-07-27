'use strict';

var _ = require('lodash');
var crypto = require('crypto');
var NodeCache = require('node-cache');

var levels = require('./levels');

function init(env, ctx) {

  // declare local constants for time differences
  var TIME_2_MINS_S = 120
    , TIME_15_MINS_S = 15 * 60
    , TIME_30_MINS_MS = 30 * 60 * 1000
    ;

  function pushnotify() {
    return pushnotify;
  }

  var receipts = new NodeCache({ stdTTL: TIME_15_MINS_S, checkperiod: 120 });
  var recentlySent = new NodeCache({ stdTTL: TIME_15_MINS_S, checkperiod: 20 });

  pushnotify.emitNotification = function emitNotification (notify) {
    if (notify.clear) {
      cancelPushoverNotifications();
      sendMakerAllClear(notify);
      return;
    }

    var key = null;
    if (notify.level >= levels.WARN) {
      //for WARN and higher use the plugin name and notification level so that louder alarms aren't triggered too often
      key = notify.plugin.name + '_' + notify.level;
    } else {
      //INFO and lower notifications should be sent as long as they are different
      key = notifyToHash(notify);
    }

    notify.key = key;

    if (recentlySent.get(key)) {
      console.info('notify: ' + key + ' has ALREADY been sent');

      return;
    }

    recentlySent.set(key, notify, 30);

    sendPushoverNotifications(notify);
    sendMakerEvent(notify);

  };

  pushnotify.pushoverAck = function pushoverAck (response) {
    if (!response.receipt) { return false; }

    var notify = receipts.get(response.receipt);
    console.info('push ack, response: ', response, ', notify: ', notify);
    if (notify) {
      ctx.notifications.ack(notify.level, TIME_30_MINS_MS, true);
    }
    return !!notify;
  };

  function cancelPushoverNotifications ( ) {
    if (ctx.pushover) {
      var receiptKeys = receipts.keys();

      _.forEach(receiptKeys, function eachKey(receipt) {
        ctx.pushover.cancelWithReceipt(receipt, function cancelCallback(err) {
          if (err) {
            console.error('error canceling receipt, err: ', err);
          } else {
            console.info('got a receipt cancel response');
          }
        });
        receipts.del(receipt);
      });
    }
  }

  function sendPushoverNotifications (notify) {

    if (!ctx.pushover) {
      return;
    }

    var msg = {
      expire: TIME_15_MINS_S
      , title: notify.title
      , message: notify.message
      , sound: notify.pushoverSound || 'gamelan'
      , timestamp: new Date()
      //USE PUSHOVER_EMERGENCY for WARN and URGENT so we get the acks
      , priority: notify.level >= levels.WARN ? ctx.pushover.PRIORITY_EMERGENCY : ctx.pushover.PRIORITY_NORMAL
    };

    if (notify.level >= levels.WARN) {
      //ADJUST RETRY TIME based on WARN or URGENT
      msg.retry = notify.level === levels.URGENT ? TIME_2_MINS_S : TIME_15_MINS_S;
      if (env.baseUrl) {
        msg.callback = env.baseUrl + '/api/v1/notifications/pushovercallback';
      }
    }

    //add the key to the cache before sending, but with a short TTL
    ctx.pushover.send(msg, function pushoverCallback (err, result) {
      if (err) {
        console.error('unable to send pushover notification', err);
      } else {
        //result comes back as a string here, so fix it
        result = JSON.parse(result);
        console.info('sent pushover notification: ', msg, 'result: ', result);
        //after successfully sent, increase the TTL
        recentlySent.ttl(notify.key, TIME_15_MINS_S);

        if (result.receipt) {
          //if this was an emergency alarm, also hold on to the receipt/notify mapping, for later acking
          receipts.set(result.receipt, notify);
        }
      }
    });
  }

  function sendMakerAllClear (notify) {
    if (ctx.maker) {
      ctx.maker.sendAllClear(notify, function makerCallback (err, result) {
        if (err) {
          console.error('unable to send maker allclear', err);
        } else if (result && result.sent) {
          console.info('sent maker allclear');
        }
      });
    }
  }

  function sendMakerEvent (notify) {
    if (!ctx.maker) {
      return;
    }

    var event = {
      name: notify.eventName || notify.plugin.name
      , level: levels.toLowerCase(notify.level)
      , value1: notify.title
      , value2: notify.message && '\n' + notify.message
    };
    ctx.maker.sendEvent(event, function makerCallback (err) {
      if (err) {
        console.error('unable to send maker event', err, event);
      } else {
        console.info('sent maker event: ', event);
        recentlySent.ttl(notify.key, TIME_15_MINS_S);
      }
    });
  }

  function notifyToHash (notify) {
    var hash = crypto.createHash('sha1');
    var info = JSON.stringify(_.pick(notify, ['title', 'message']));
    hash.update(info);
    return hash.digest('hex');
  }

  return pushnotify();
}


module.exports = init;