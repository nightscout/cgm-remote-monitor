'use strict';

var _ = require('lodash');

var THIRTY_MINUTES = 30 * 60 * 1000;

var Alarm = function(label) {
  this.label = label;
  this.silenceTime = THIRTY_MINUTES;
  this.lastAckTime = 0;
};

// list of alarms with their thresholds
var alarms = {};

function init (env, ctx) {
  function notifications () {
    return notifications;
  }

  //aligned with https://pushover.net/api#priority
  var levels = {
    URGENT: 2
    , WARN: 1
    , INFO: 0
    , LOW: -1
    , LOWEST: -2
    , NONE: -3
  };

  notifications.levels = levels;

  notifications.levels.toString = function levelToString(level) {
    switch (level) {
      case 2:
        return 'Urgent';
      case 1:
        return 'Warning';
      case 0:
        return 'Info';
      case -1:
        return 'Low';
      case -2:
        return 'Lowest';
    }
  };

  notifications.levels.toLowerCase = function toLowerCase(level) {
    return notifications.levels.toString(level).toLowerCase();
  };

  function getAlarm (level) {
    var alarm = alarms[level];
    if (!alarm) {
      alarm = new Alarm(levels.toString(level));
      alarms[level] = alarm;
    }
    return alarm;
  }

  //should only be used when auto acking the alarms after going back in range or when an error corrects
  //setting the silence time to 1ms so the alarm will be re-triggered as soon as the condition changes
  //since this wasn't ack'd by a user action
  function autoAckAlarms() {

    var sendClear = false;

    for (var level = 1; level <=2; level++) {
      var alarm = getAlarm(level);
      if (alarm.lastEmitTime) {
        console.info('auto acking ' + alarm.level);
        notifications.ack(alarm.level, 1);
        sendClear = true;
      }
    }

    if (sendClear) {
      ctx.bus.emit('notification', {clear: true, title: 'All Clear', message: 'Auto ack\'d alarm(s)'});
      console.info('emitted notification clear');
    }
  }

  function emitNotification (notify) {
    var alarm = getAlarm(notify.level);
    if (ctx.data.lastUpdated > alarm.lastAckTime + alarm.silenceTime) {
      ctx.bus.emit('notification', notify);
      alarm.lastEmitTime = ctx.data.lastUpdated;
      console.info('emitted notification:', notify);
    } else {
      console.log(alarm.label + ' alarm is silenced for ' + Math.floor((alarm.silenceTime - (ctx.data.lastUpdated - alarm.lastAckTime)) / 60000) + ' minutes more');
    }
  }

  var requests = {};

  notifications.initRequests = function initRequests ( ) {
    requests = { notifies: [] , snoozes: []};
  };

  notifications.initRequests();

  /**
   * Find the first URGENT or first WARN
   * @returns a notification or undefined
   */
  notifications.findHighestAlarm = function findHighestAlarm ( ) {
    return _.find(requests.notifies, {level: levels.URGENT}) || _.find(requests.notifies, {level: levels.WARN});
  };

  notifications.findInfos = function findInfos ( ) {
    return _.filter(requests.notifies, function (notify) {
      return notify.level <= levels.INFO;
    });
  };

  notifications.snoozedBy = function snoozedBy (notify) {
    if (_.isEmpty(requests.snoozes)) return false;

    var byLevel = _.filter(requests.snoozes, function checkSnooze (snooze) {
      return snooze.level >= notify.level;
    });
    var sorted = _.sortBy(byLevel, 'mills');
    var longest = _.last(sorted);

    var alarm = getAlarm(notify.level);

    if (longest && Date.now() + longest.lengthMills > alarm.lastAckTime + alarm.silenceTime) {
      return longest;
    } else {
      return null;
    }
  };

  notifications.requestNotify = function requestNotify (notify) {
    if (!notify.hasOwnProperty('level') || !notify.title || !notify.message || !notify.plugin) {
      console.error(new Error('Unable to request notification, since the notify isn\'t complete: ' + JSON.stringify(notify)));
      return;
    }
    requests.notifies.push(notify);
  };

  notifications.requestSnooze = function requestSnooze (snooze) {
    if (!snooze.level || !snooze.lengthMills) {
      console.error(new Error('Unable to request snooze, since the snooze isn\'t complete: ' + JSON.stringify(snooze)));
      return;
    }
    requests.snoozes.push(snooze);
  };

  notifications.process = function process ( ) {
    var highestAlarm = notifications.findHighestAlarm();

    if (highestAlarm) {
      var snoozedBy = notifications.snoozedBy(highestAlarm);
      if (snoozedBy) {
        console.log('snoozing: ', highestAlarm, ' with: ', snoozedBy);
        notifications.ack(snoozedBy.level, snoozedBy.lengthMills);
      }

      emitNotification(highestAlarm);
    } else {
      autoAckAlarms();
    }

    notifications.findInfos().forEach(function eachInfo (info) {
      emitNotification(info);
    });
  };

  notifications.ack = function ack (level, time, sendClear) {
    var alarm = getAlarm(level);
    if (!alarm) {
      console.warn('Got an ack for an unknown alarm time');
      return;
    }
    alarm.lastAckTime = new Date().getTime();
    alarm.silenceTime = time ? time : THIRTY_MINUTES;
    delete alarm.lastEmitTime;

    if (level == 2) {
      notifications.ack(1, time);
    }

    if (sendClear) {
      ctx.bus.emit('notification', {
        clear: true
        , title: 'All Clear'
        , message: notifications.levels.toString(level) + ' was ack\'d'
      });
    }

  };

  return notifications();
}

module.exports = init;