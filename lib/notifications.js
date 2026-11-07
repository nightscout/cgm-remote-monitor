'use strict';

var THIRTY_MINUTES = 30 * 60 * 1000;
var DEFAULT_GROUPS = ['default'];

var Alarm = function(level, group, label) {
  this.level = level;
  this.group = group;
  this.label = label;
  this.silenceTime = THIRTY_MINUTES;
  this.lastAckTime = 0;
};

function init (env, ctx, privateOptions) {
  // Snoozes and pending requests belong to this service, not the module cache.
  var alarms = {};
  var closed = false;
  var processingClock = privateOptions ? privateOptions.clock : function () { return Date.now(); };
  if (privateOptions) alarms = privateOptions.restore();

  function notifications () {
    return notifications;
  }

  function getAlarm (level, group) {
    if (closed) return;
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
    if (closed) return;
    requests = { notifies: [], snoozes: [] };
  };

  notifications.initRequests();

  /**
   * Find the first URGENT or first WARN
   * @returns a notification or undefined
   */  notifications.findHighestAlarm = function findHighestAlarm (group) {
    group = group || 'default';
    var filtered = requests.notifies.filter(function(notify) { return notify.group === group; });
    return filtered.find(notify => notify.level === ctx.levels.URGENT) || filtered.find(notify => notify.level === ctx.levels.WARN);
  };
  notifications.findUnSnoozeable = function findUnSnoozeable () {
    return requests.notifies.filter(function(notify) {
      return notify.level <= ctx.levels.INFO || notify.isAnnouncement;
    });
  };
  notifications.snoozedBy = function snoozedBy (notify) {
    if (notify.isAnnouncement) { return false; }

    var filtered = requests.snoozes.filter(function(snooze) { return snooze.group === notify.group; });

    if (filtered.length === 0) { return false; }
    var byLevel = filtered.filter(function checkSnooze (snooze) {
      return snooze.level >= notify.level;
    });
    var sorted = byLevel.sort((a, b) => a.lengthMills - b.lengthMills);

    return sorted.length > 0 ? sorted[sorted.length - 1] : null;
  };

  notifications.requestNotify = function requestNotify (notify) {
    if (closed) return;
    if (!Object.prototype.hasOwnProperty.call(notify, 'level') || !notify.title || !notify.message || !notify.plugin) {
      console.error(new Error('Unable to request notification, since the notify isn\'t complete: ' + JSON.stringify(notify)));
      return;
    }

    notify.group = notify.group || 'default';

    requests.notifies.push(notify);
  };

  notifications.requestSnooze = function requestSnooze (snooze) {
    if (closed) return;
    if (!snooze.level || !snooze.title || !snooze.message || !snooze.lengthMills) {
      console.error(new Error('Unable to request snooze, since the snooze isn\'t complete: ' + JSON.stringify(snooze)));
      return;
    }

    snooze.group = snooze.group || 'default';

    requests.snoozes.push(snooze);
  };
  notifications.process = function process () {
    if (closed) return;

    var notifyGroups = requests.notifies.map(function eachNotify (notify) {
      return notify.group;
    });

    var alarmGroups = Object.values(alarms).map(function eachAlarm (alarm) {
      return alarm.group;
    });

    var groups = [...new Set(notifyGroups.concat(alarmGroups))];
    if (groups.length === 0) {
      groups = DEFAULT_GROUPS.slice();
    }

    groups?.forEach(function eachGroup (group) {
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

  function acknowledge (level, group, time, sendClear, at) {
    if (closed) return;
    var alarm = getAlarm(level, group);
    if (!alarm) {
      console.warn('Got an ack for an unknown alarm time, level:', level, ', group:', group);
      return;
    }

    if ((privateOptions ? at : Date.now()) < alarm.lastAckTime + alarm.silenceTime) {
      console.warn('Alarm has already been snoozed, don\'t snooze it again, level:', level, ', group:', group);
      return;
    }

    alarm.lastAckTime = privateOptions ? at : Date.now();
    alarm.silenceTime = time ? time : THIRTY_MINUTES;
    delete alarm.lastEmitTime;

    if (level === 2) {
      if (privateOptions) acknowledge(1, group, time, false, at);
      else notifications.ack(1, group, time);
    }

    /*
    * TODO: modify with a local clear, this will clear all connected clients,
    * globally
    */
    if (sendClear) {
      var notify = {
        clear: true
        , title: 'All Clear'
        , message: group + ' - ' + ctx.levels.toDisplay(level) + ' was ack\'d'
        , group: group
      };
      // When web client sends ack, this translates the websocket message into
      // an event on our internal bus.
      ctx.bus.emit('notification', notify);
      logEmitEvent(notify);
    }
    return true;
  }

  notifications.ack = function ack (level, group, time, sendClear) {
    acknowledge(level, group, time, sendClear, privateOptions ? processingClock() : undefined);
  };

  if (privateOptions) privateOptions.bind({
    snapshot: function snapshot () {
      if (closed) throw new Error('NOTIFICATION_STATE_CLOSED');
      return privateOptions.validate(Object.values(alarms).map(function (alarm) {
        var row = {level: alarm.level, group: alarm.group, lastAckTime: alarm.lastAckTime, silenceTime: alarm.silenceTime};
        if (alarm.lastEmitTime !== undefined) row.lastEmitTime = alarm.lastEmitTime;
        return row;
      }));
    },
    ackAt: function ackAt (level, group, time, sendClear, at) {
      privateOptions.instant(at);
      return acknowledge(level, group, time, sendClear, at) === true;
    }
  });

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

  if (ctx.bus) ctx.bus.once('teardown', function closeNotifications () {
    closed = true;
    alarms = {};
    requests = {notifies: [], snoozes: []};
  });

  return notifications();
}

module.exports = init;

// Trusted selected-role capability. State is private producer state, never browser
// payload or plugin authority. The default factory and its clock are unchanged.
module.exports.privateState = function privateState (env, ctx, options) {
  if (!options || typeof options.clock !== 'function' ||
      !Number.isSafeInteger(options.maxRows) || options.maxRows < 1 ||
      !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new TypeError('Explicit bounded private notification state required');
  }
  function instant (value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid notification state time');
    return value;
  }
  function validate (rows) {
    if (!Array.isArray(rows) || rows.length > options.maxRows ||
        Buffer.byteLength(JSON.stringify(rows)) > options.maxBytes) throw new Error('NOTIFICATION_STATE_BOUND');
    var keys = new Set();
    rows.forEach(function (row) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['level', 'group', 'lastAckTime', 'silenceTime', 'lastEmitTime'].includes(key)) ||
          !Number.isSafeInteger(row.level) || row.level < -3 || row.level > 2 ||
          typeof row.group !== 'string' || !row.group.length || Buffer.byteLength(row.group) > 512) throw new TypeError('Invalid notification state row');
      instant(row.lastAckTime); instant(row.silenceTime); instant(row.lastAckTime + row.silenceTime);
      if (row.lastEmitTime !== undefined) instant(row.lastEmitTime);
      var key = row.level + '-' + row.group;
      if (keys.has(key)) throw new TypeError('Duplicate notification state row');
      keys.add(key);
    });
    return JSON.parse(JSON.stringify(rows));
  }
  var capability;
  var notifications = init(env, ctx, {
    clock: function () { return instant(options.clock()); }, instant, validate,
    restore: function () {
      var restored = Object.create(null);
      validate(options.state || []).forEach(function (row) {
        var display = row.group === 'default' ? ctx.levels.toDisplay(row.level) : row.group + ':' + row.level;
        restored[row.level + '-' + row.group] = Object.assign(new Alarm(row.level, row.group, display), row);
      });
      return restored;
    },
    bind: function (value) { capability = value; }
  });
  return Object.freeze({notifications, snapshot: capability.snapshot, ackAt: capability.ackAt});
};
