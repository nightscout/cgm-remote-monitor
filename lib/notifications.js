'use strict';

var _ = require('lodash');
var THIRTY_MINUTES = 30 * 60 * 1000;
var DEFAULT_GROUPS = ['default'];

var Alarm = function(level, group, label) {
  this.level = level;
  this.group = group;
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

  function getAlarm (level, group) {
    var key = level + '-' + group;
    var alarm = alarms[key];
    if (!alarm) {
      var display = group === 'default' ? ctx.levels.toDisplay(level) : group + ':' + level;
      alarm = new Alarm(level, group, display);
      alarms[key] = alarm;
    }

    return alarm;
  }

  //should only be used when auto acking the alarms after going back in range or when an error corrects
  //setting the silence time to 1ms so the alarm will be re-triggered as soon as the condition changes
  //since this wasn't ack'd by a user action
  function autoAckAlarms (group) {

    var sendClear = false;

    for (var level = 1; level <= 2; level++) {
      var alarm = getAlarm(level, group);
      if (alarm.lastEmitTime) {
        console.info('auto acking ' + alarm.level, ' - ', group);
        notifications.ack(alarm.level, group, 1);
        sendClear = true;
      }
    }

    if (sendClear) {
      var notify = { clear: true, title: 'All Clear', message: 'Auto ack\'d alarm(s)', group: group };
      ctx.bus.emit('notification', notify);
      logEmitEvent(notify);
    }
  }

  function emitNotification (notify) {
    var alarm = getAlarm(notify.level, notify.group);
    if (ctx.ddata.lastUpdated > alarm.lastAckTime + alarm.silenceTime) {
      ctx.bus.emit('notification', notify);
      alarm.lastEmitTime = ctx.ddata.lastUpdated;
      logEmitEvent(notify);
    } else {
      console.log(alarm.label + ' alarm is silenced for ' + Math.floor((alarm.silenceTime - (ctx.ddata.lastUpdated - alarm.lastAckTime)) / 60000) + ' minutes more');
    }
  }

  var requests = {};

  notifications.initRequests = function initRequests () {
    requests = { notifies: [], snoozes: [] };
  };

  notifications.initRequests();

  /**
   * Find the first URGENT or first WARN
   * @returns a notification or undefined
   */
  notifications.findHighestAlarm = function findHighestAlarm (group) {
    group = group || 'default';
    var filtered = _.filter(requests.notifies, { group: group });
    return _.find(filtered, { level: ctx.levels.URGENT }) || _.find(filtered, { level: ctx.levels.WARN });
  };

  notifications.findUnSnoozeable = function findUnSnoozeable () {
    return _.filter(requests.notifies, function(notify) {
      return notify.level <= ctx.levels.INFO || notify.isAnnouncement;
    });
  };

  notifications.snoozedBy = function snoozedBy (notify) {
    if (notify.isAnnouncement) { return false; }

    var filtered = _.filter(requests.snoozes, { group: notify.group });

    if (_.isEmpty(filtered)) { return false; }

    var byLevel = _.filter(filtered, function checkSnooze (snooze) {
      return snooze.level >= notify.level;
    });
    var sorted = _.sortBy(byLevel, 'lengthMills');

    return _.last(sorted);
  };

  notifications.requestNotify = function requestNotify (notify) {
    if (!Object.prototype.hasOwnProperty.call(notify, 'level') || !notify.title || !notify.message || !notify.plugin) {
      console.error(new Error('Unable to request notification, since the notify isn\'t complete: ' + JSON.stringify(notify)));
      return;
    }

    notify.group = notify.group || 'default';

    requests.notifies.push(notify);
  };

  notifications.requestSnooze = function requestSnooze (snooze) {
    if (!snooze.level || !snooze.title || !snooze.message || !snooze.lengthMills) {
      console.error(new Error('Unable to request snooze, since the snooze isn\'t complete: ' + JSON.stringify(snooze)));
      return;
    }

    snooze.group = snooze.group || 'default';

    requests.snoozes.push(snooze);
  };

  notifications.process = function process () {

    var notifyGroups = _.map(requests.notifies, function eachNotify (notify) {
      return notify.group;
    });

    var alarmGroups = _.map(_.values(alarms), function eachAlarm (alarm) {
      return alarm.group;
    });

    var groups = _.uniq(notifyGroups.concat(alarmGroups));

    if (_.isEmpty(groups)) {
      groups = DEFAULT_GROUPS.slice();
    }

    _.each(groups, function eachGroup (group) {
      var highestAlarm = notifications.findHighestAlarm(group);

      if (highestAlarm) {
        var snoozedBy = notifications.snoozedBy(highestAlarm, group);
        if (snoozedBy) {
          logSnoozingEvent(highestAlarm, snoozedBy);
          notifications.ack(snoozedBy.level, group, snoozedBy.lengthMills, true);
        } else {
          emitNotification(highestAlarm);
        }
      } else {
        autoAckAlarms(group);
      }
    });

    notifications.findUnSnoozeable().forEach(function eachInfo (notify) {
      emitNotification(notify);
    });
  };

  notifications.ack = function ack (level, group, time, sendClear) {
    var alarm = getAlarm(level, group);
    if (!alarm) {
      console.warn('Got an ack for an unknown alarm time, level:', level, ', group:', group);
      return;
    }

    if (Date.now() < alarm.lastAckTime + alarm.silenceTime) {
      console.warn('Alarm has already been snoozed, don\'t snooze it again, level:', level, ', group:', group);
      return;
    }

    alarm.lastAckTime = Date.now();
    alarm.silenceTime = time ? time : THIRTY_MINUTES;
    delete alarm.lastEmitTime;

    if (level === 2) {
      notifications.ack(1, group, time);
    }

    if (sendClear) {
      var notify = {
        clear: true
        , title: 'All Clear'
        , message: group + ' - ' + ctx.levels.toDisplay(level) + ' was ack\'d'
        , group: group
      };
      ctx.bus.emit('notification', notify);
      logEmitEvent(notify);
    }

  };

  function ifTestModeThen (callback) {
    if (env.testMode) {
      return callback();
    } else {
      throw 'Test only function was called = while not in test mode';
    }
  }

  notifications.resetStateForTests = function resetStateForTests () {
    ifTestModeThen(function doResetStateForTests () {
      console.info('resetting notifications state for tests');
      alarms = {};
    });
  };

  notifications.getAlarmForTests = function getAlarmForTests (level, group) {
    return ifTestModeThen(function doResetStateForTests () {
      group = group || 'default';
      var alarm = getAlarm(level, group);
      console.info('got alarm for tests: ', alarm);
      return alarm;
    });
  };

  function notifyToView (notify) {
    return {
      level: ctx.levels.toDisplay(notify.level)
      , title: notify.title
      , message: notify.message
      , group: notify.group
      , plugin: notify.plugin ? notify.plugin.name : '<none>'
      , debug: notify.debug
    };
  }

  function snoozeToView (snooze) {
    return {
      level: ctx.levels.toDisplay(snooze.level)
      , title: snooze.title
      , message: snooze.message
      , group: snooze.group
    };
  }

  function logEmitEvent (notify) {
    var type = notify.level >= ctx.levels.WARN ? 'ALARM' : (notify.clear ? 'ALL CLEAR' : 'NOTIFICATION');
    console.info([
      logTimestamp() + '\tEMITTING ' + type + ':'
      , '  ' + JSON.stringify(notifyToView(notify))
    ].join('\n'));
  }

  function logSnoozingEvent (highestAlarm, snoozedBy) {
    console.info([
      logTimestamp() + '\tSNOOZING ALARM:'
      , '  ' + JSON.stringify(notifyToView(highestAlarm))
      , '  BECAUSE:'
      , '    ' + JSON.stringify(snoozeToView(snoozedBy))
    ].join('\n'));
  }

  //TODO: we need a common logger, but until then...
  function logTimestamp () {
    return (new Date).toISOString();
  }

  return notifications();
}

module.exports = init;
