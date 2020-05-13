'use strict';

const _ = require('lodash');
const crypto = require('crypto');
const NodeCache = require('node-cache');

const levels = require('../levels');
const times = require('../times');

function init (env, ctx) {

  function pushnotify () {
    return pushnotify;
  }

  var receipts = new NodeCache({ stdTTL: times.hour().secs, checkperiod: times.mins(5).secs });
  var recentlySent = new NodeCache({ stdTTL: times.mins(15).secs, checkperiod: 20 });

  pushnotify.emitNotification = function emitNotification (notify) {
    if (notify.clear) {
      cancelPushoverNotifications();
      sendMakerAllClear(notify);
      return;
    }

    var key = notify.notifyhash || false;

    if (!key) {
      if (notify.isAnnouncement) {
        //Announcement notifications are sent if they are different from whats been recently sent
        key = notifyToHash(notify);
      } else if (levels.isAlarm(notify.level)) {
        //Alarms can be snoozed
        //for WARN and higher use the plugin name and notification level so that louder alarms aren't triggered too often
        key = notify.plugin.name + '_' + notify.level;
      } else {
        //INFO and lower notifications should be sent as long as they are different from whats been recently sent
        key = notifyToHash(notify);
      }
    }

    notify.key = key;

    if (recentlySent.get(key)) {
      console.info('notify: ' + key + ' has ALREADY been sent');
      return;
    } else if (!env.settings.isAlarmEventEnabled(notify)) {
      console.info('notify: ' + key + ' will NOT be sent, it\'s been disabled');
      return;
    }

    recentlySent.set(key, notify, 30);

    sendPushoverNotifications(notify);
    sendMakerEvent(notify);

  };

  pushnotify.pushoverAck = function pushoverAck (response) {
    if (!response.receipt) { return false; }

    var notify = receipts.get(response.receipt);
    if (notify) {
      console.info('push ack, response: ', response, ', notify: ', notify);
      var snoozeMins = env.settings.snoozeFirstMinsForAlarmEvent(notify);
      ctx.notifications.ack(notify.level, notify.group, times.mins(snoozeMins).msecs, true);
      receipts.del(response.receipt);
    } else {
      console.info('unable to find notify for pushover ack', response, receipts.keys());
    }

    return !!notify;
  };

  function cancelPushoverNotifications () {
    if (ctx.pushover) {
      var receiptKeys = receipts.keys();

      _.each(receiptKeys, function eachKey (receipt) {
        ctx.pushover.cancelWithReceipt(receipt, function cancelCallback (err) {
          if (err) {
            console.error('error canceling receipt:' + receipt + ', err: ', err);
          } else {
            console.info('got a receipt cancel response for:' + receipt + ', removing from cache');
            receipts.del(receipt);
          }
        });
      });
    }
  }

  function sendPushoverNotifications (notify) {
    if (ctx.pushover) {
      //add the key to the cache before sending, but with a short TTL
      ctx.pushover.send(notify, function pushoverCallback (err, result) {
        if (err) {
          console.warn('Unable to send pushover', notify, err);
        } else {
          //result comes back as a string here, so fix it
          result = JSON.parse(result);
          //after successfully sent, increase the TTL
          recentlySent.ttl(notify.key, times.mins(15).secs);

          if (result.receipt) {
            //if this was an emergency alarm, also hold on to the receipt/notify mapping, for later acking
            console.info('storing pushover receipt', result.receipt, notify);
            receipts.set(result.receipt, notify);
          }
        }
      });
    }
  }

  function sendMakerAllClear (notify) {
    if (ctx.maker) {
      ctx.maker.sendAllClear(notify, function makerCallback (err, result) {
        if (err) {
          console.error('unable to send maker allclear', notify, err);
        } else if (result && result.sent) {
          console.info('sent maker allclear', notify);
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
      , isAnnouncement: notify.isAnnouncement
    };
    ctx.maker.sendEvent(event, function makerCallback (err) {
      if (err) {
        console.error('unable to send maker event', event, err);
      } else {
        console.info('sent maker event: ', event);
        recentlySent.ttl(notify.key, times.mins(15).secs);
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
