'use strict';

var _ = require('lodash');
var levels = require('./levels');

var THIRTY_MINUTES = 30 * 60 * 1000;

var Alarm = function(level, label) {
  this.level = level;
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

  function getAlarm (level) {
    var alarm = alarms[level];
    if (!alarm) {
      //TODO: Announcement hack a1/a2
      var display = level.indexOf && level.indexOf('a') === 0 ? 'Announcement:' + level : levels.toDisplay(level);
      alarm = new Alarm(level, display);
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
      var notify = {clear: true, title: 'All Clear', message: 'Auto ack\'d alarm(s)'};
      ctx.bus.emit('notification', notify);
      logEmitEvent(notify);
    }
  }

  function emitNotification (notify) {
    //TODO: Announcement hack a1/a2
    var level = notify.isAnnouncement ? 'a' + notify.level : notify.level;
    var alarm = getAlarm(level);
    if (ctx.data.lastUpdated > alarm.lastAckTime + alarm.silenceTime) {
      ctx.bus.emit('notification', notify);
      alarm.lastEmitTime = ctx.data.lastUpdated;
      logEmitEvent(notify);
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

  notifications.findUnSnoozeable = function findUnSnoozeable ( ) {
    return _.filter(requests.notifies, function (notify) {
      return notify.level <= levels.INFO || notify.isAnnouncement;
    });
  };

  notifications.snoozedBy = function snoozedBy (notify) {
    if (notify.isAnnouncement) { return false; }
    if (_.isEmpty(requests.snoozes)) { return false; }

    var byLevel = _.filter(requests.snoozes, function checkSnooze (snooze) {
      return snooze.level >= notify.level;
    });
    var sorted = _.sortBy(byLevel, 'lengthMills');

    return _.last(sorted);
  };

  notifications.requestNotify = function requestNotify (notify) {
    if (!notify.hasOwnProperty('level') || !notify.title || !notify.message || !notify.plugin) {
      console.error(new Error('Unable to request notification, since the notify isn\'t complete: ' + JSON.stringify(notify)));
      return;
    }
    requests.notifies.push(notify);
  };

  notifications.requestSnooze = function requestSnooze (snooze) {
    if (!snooze.level || !snooze.title || !snooze.message || !snooze.lengthMills) {
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
        logSnoozingEvent(highestAlarm, snoozedBy);
        notifications.ack(snoozedBy.level, snoozedBy.lengthMills, true);
      } else {
        emitNotification(highestAlarm);
      }
    } else {
      autoAckAlarms();
    }

    notifications.findUnSnoozeable().forEach(function eachInfo (notify) {
      emitNotification(notify);
    });
  };

  notifications.ack = function ack (level, time, sendClear) {
    var alarm = getAlarm(level);
    if (!alarm) {
      console.warn('Got an ack for an unknown alarm time');
      return;
    }

    if (Date.now() < alarm.lastAckTime + alarm.silenceTime) {
      console.warn('Alarm has already been snoozed, don\'t snooze it again');
      return;
    }

    alarm.lastAckTime = Date.now();
    alarm.silenceTime = time ? time : THIRTY_MINUTES;
    delete alarm.lastEmitTime;

    if (level === 2) {
      notifications.ack(1, time);
    }

    if (sendClear) {
      var notify = {
        clear: true, title: 'All Clear', message: levels.toDisplay(level) + ' was ack\'d'
      };
      ctx.bus.emit('notification', notify);
      logEmitEvent(notify);
    }

  };

  function ifTestModeThen(callback) {
    if (env.testMode) {
      return callback();
    } else {
      throw 'Test only function was called = while not in test mode';
    }
  }

  notifications.resetStateForTests = function resetStateForTests ( ) {
    ifTestModeThen(function doResetStateForTests ( ) {
      console.info('resetting notifications state for tests');
      alarms = {};
    });
  };

  notifications.getAlarmForTests = function getAlarmForTests (level) {
    return ifTestModeThen(function doResetStateForTests () {
      var alarm = getAlarm(level);
      console.info('got alarm for tests: ', alarm);
      return alarm;
    });
  };

  function notifyToView (notify) {
    return {
      level: levels.toDisplay(notify.level)
      , title: notify.title
      , message: notify.message
      , plugin: notify.plugin ? notify.plugin.name : '<none>'
      , debug: notify.debug
    };
  }

  function snoozeToView (snooze) {
    return {
      level: levels.toDisplay(snooze.level)
      , title: snooze.title
      , message: snooze.message
    };
  }

  function logEmitEvent(notify) {
    var type = notify.level >= levels.WARN ? 'ALARM' : (notify.clear ? 'ALL CLEAR' : 'NOTIFICATION');
    console.info([
      logTimestamp() + '\tEMITTING ' + type + ':'
      , '  ' + JSON.stringify(notifyToView(notify))
    ].join('\n'));
  }

  function logSnoozingEvent(highestAlarm, snoozedBy) {
    console.info([
      logTimestamp() + '\tSNOOZING ALARM:'
      , '  ' + JSON.stringify(notifyToView(highestAlarm))
      , '  BECAUSE:'
      , '    ' + JSON.stringify(snoozeToView(snoozedBy))
    ].join('\n'));
  }

  //TODO: we need a common logger, but until then...
  function logTimestamp ( ) {
    return (new Date).toISOString();
  }

  return notifications();
}

module.exports = init;