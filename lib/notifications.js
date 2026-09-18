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

// list of alarms with their thresholds
var alarms = {};

function init (env, ctx) {

  var REFRESH_TIMEOUT_MS = parseInt(process.env.ALARM_REFRESH_TIMEOUT_MS, 10) || 5000;

  function notifications () {
    return notifications;
  }

  function getAlarm (level, group) {
    group = group || 'default';
    var key = level + '-' + group;
    var alarm = alarms[key];
    if (!alarm) {
      var display = group === 'default' ? ctx.levels.toDisplay(level) : group + ':' + level;
      alarm = new Alarm(level, group, display);
      alarms[key] = alarm;
      // Defer first emit per (level, group) per process until storage refresh
      // resolves or REFRESH_TIMEOUT_MS elapses. INFO is not snoozeable so skip.
      var isSnoozeable = ctx.levels && level >= ctx.levels.WARN;
      if (isSnoozeable && ctx.alarmStorage) {
        alarm.refreshPending = true;
        alarm.pendingNotify = null;
        alarm.refreshDeadline = Date.now() + REFRESH_TIMEOUT_MS;

        // Shared helper: clear the refresh window and retry any deferred notification.
        // Called by both .then() and .catch() to eliminate duplication and ensure
        // a try/catch guards emitNotification so no throw escapes as an unhandled rejection.
        // Fail-open on storage errors: emitting with stale state is safer than silent drop
        // on a medical safety device.
        var resolveRefresh = function resolveRefresh () {
          if (!alarm.refreshPending) {
            if (alarm.pendingNotify) {
              console.warn(alarm.label + ' alarm: pendingNotify set but refreshPending already false (deadline fired?); discarding');
              alarm.pendingNotify = null;
            }
            return;
          }
          alarm.refreshPending = false;
          var pending = alarm.pendingNotify;
          alarm.pendingNotify = null;
          if (pending) {
            try {
              emitNotification(pending);
            } catch (emitErr) {
              console.error('Failed to emit pending notification for ' + level + '-' + group + ': ' +
                (emitErr && emitErr.message ? emitErr.message : String(emitErr)));
            }
          }
        }

        ctx.alarmStorage.getSnooze(level, group).then(function (doc) {
          // Always update in-memory state from storage if doc is newer, even if the
          // deadline already fired and we emitted optimistically from stale state.
          if (doc && doc.lastAckTime > alarm.lastAckTime) {
            alarm.lastAckTime = doc.lastAckTime;
            alarm.silenceTime = doc.silenceTime;
            console.info('alarm ' + level + '-' + group +
              ' loaded snooze from storage, expiresAt=' +
              new Date(doc.lastAckTime + doc.silenceTime).toISOString());
          }
          resolveRefresh();
        }).catch(function (err) {
          console.warn('alarmStorage.getSnooze failed for ' + level + '-' + group + ': ' +
            (err && err.message ? err.message : String(err)));
          resolveRefresh();
        });
      }
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
    // Defer emission while storage refresh is pending and within the timeout window.
    // After the deadline, fall through and emit based on whatever in-memory state holds.
    if (alarm.refreshPending) {
      if (Date.now() < alarm.refreshDeadline) {
        if (alarm.pendingNotify) {
          console.warn(alarm.label + ' alarm: replacing queued pendingNotify during refresh window (rapid process() calls)');
        }
        alarm.pendingNotify = notify;
        console.log(alarm.label + ' alarm deferred -- awaiting storage refresh');
        return;
      }
      console.warn(alarm.label + ' alarm refresh DEADLINE exceeded -- emitting from in-memory state');
      alarm.refreshPending = false;
      if (alarm.pendingNotify && alarm.pendingNotify !== notify) {
        console.warn(alarm.label + ' alarm: discarding stale pendingNotify at deadline; emitting current notify');
      }
      alarm.pendingNotify = null;
    }
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

  notifications.ack = function ack (level, group, time, sendClear) {
    group = group || 'default';
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
    // User explicitly acked; refresh window no longer relevant for this alarm.
    alarm.refreshPending = false;
    alarm.pendingNotify = null;

    // Persist this snooze so other instances honor it.
    if (ctx.alarmStorage) {
      ctx.alarmStorage.setSnooze(level, group, alarm.lastAckTime, alarm.silenceTime).catch(function (err) {
        console.warn('alarmStorage.setSnooze failed for ' + level + '-' + group + ': ' + err.message);
      });
    }

    if (level === 2) {
      notifications.ack(1, group, time);
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
