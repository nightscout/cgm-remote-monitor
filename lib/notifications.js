'use strict';

var THIRTY_MINUTES = 30 * 60 * 1000;
var MAX_DATE_MS = 8640000000000000;
var MAX_REFRESH_TIMEOUT_MS = 15000;
var MAX_SNOOZE_MS = 24 * 60 * 60 * 1000;
var MAX_CLOCK_SKEW_MS = 60 * 1000;
var ANNOUNCEMENT_GROUP = 'Announcement';
var MAX_GROUP_LENGTH = 64;
var DEFAULT_GROUPS = ['default'];

var Alarm = function(level, group, label) {
  this.level = level;
  this.group = group;
  this.label = label;
  this.silenceTime = THIRTY_MINUTES;
  this.lastAckTime = 0;
};

function init (env, ctx) {
  // Snoozes and pending requests belong to this service, not the module cache.
  var alarms = {};
  var closed = false;

  function positiveIntegerSetting (value, fallback, maximum) {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback;
    var parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 &&
      (maximum === undefined || parsed <= maximum) ? parsed : fallback;
  }

  var REFRESH_TIMEOUT_MS = positiveIntegerSetting(process.env.ALARM_REFRESH_TIMEOUT_MS, 5000, MAX_REFRESH_TIMEOUT_MS);
  var REFRESH_STALE_MS = positiveIntegerSetting(process.env.ALARM_REFRESH_STALE_MS, 30000);

  function notifications () {
    return notifications;
  }

  function clearRefreshTimer (alarm) {
    if (alarm.refreshTimer) clearTimeout(alarm.refreshTimer);
    alarm.refreshTimer = null;
  }

  function invalidateRefresh (alarm) {
    clearRefreshTimer(alarm);
    alarm.refreshGeneration = (alarm.refreshGeneration || 0) + 1;
    alarm.refreshPending = false;
    alarm.pendingNotify = null;
  }

  function storedSnoozeExpiry (doc) {
    if (!doc || !Number.isFinite(doc.lastAckTime) || !Number.isFinite(doc.silenceTime) ||
        doc.lastAckTime < 0 || doc.silenceTime <= 0 || doc.silenceTime > MAX_SNOOZE_MS) return null;
    var expiry = doc.lastAckTime + doc.silenceTime;
    // A snooze acked in the future (a skewed clock or a hand-edited document) must
    // not silence alarms for longer than its own length plus a little skew.
    if (doc.lastAckTime > Date.now() + MAX_CLOCK_SKEW_MS) return null;
    return Number.isSafeInteger(expiry) && expiry <= MAX_DATE_MS ? expiry : null;
  }

  function isPersistableSnooze (level, group, silenceTime) {
    return ctx.levels && (level === ctx.levels.WARN || level === ctx.levels.URGENT) &&
      typeof group === 'string' && group.length <= MAX_GROUP_LENGTH && group !== ANNOUNCEMENT_GROUP &&
      typeof silenceTime === 'number' && Number.isFinite(silenceTime) &&
      silenceTime > 1 && silenceTime <= MAX_SNOOZE_MS; // 1 ms is the auto-ack
  }

  // Writes the alarm's current snooze to storage. A failed write leaves the
  // snooze on this instance only; unsavedSnooze lets the next ack retry it.
  function persistSnooze (alarm, level, group) {
    if (!ctx.alarmStorage || !isPersistableSnooze(level, group, alarm.silenceTime)) return;
    var lastAckTime = alarm.lastAckTime;
    alarm.unsavedSnooze = true;
    ctx.alarmStorage.setSnooze(level, group, lastAckTime, alarm.silenceTime).then(function () {
      if (alarm.lastAckTime === lastAckTime) alarm.unsavedSnooze = false;
    }, function (err) {
      console.warn('alarmStorage.setSnooze failed for ' + level + '-' + group + ': ' +
        (err && err.message ? err.message : String(err)));
    });
  }

  function applyStoredSnooze (alarm, doc, level, group) {
    if (!doc) return;
    var storedExpiry = storedSnoozeExpiry(doc);
    if (storedExpiry === null) {
      console.warn('alarmStorage.getSnooze returned invalid data for ' + level + '-' + group + '; ignoring');
      return;
    }
    var inMemoryExpiry = alarm.lastAckTime + alarm.silenceTime;
    if (storedExpiry > inMemoryExpiry) {
      alarm.lastAckTime = doc.lastAckTime;
      alarm.silenceTime = doc.silenceTime;
      alarm.unsavedSnooze = false;
      console.info('alarm ' + level + '-' + group +
        ' loaded snooze from storage, expiresAt=' +
        new Date(storedExpiry).toISOString());
    }
  }

  function resolveRefresh (alarm, level, group, generation) {
    if (generation !== alarm.refreshGeneration || !alarm.refreshPending) return;
    clearRefreshTimer(alarm);
    alarm.refreshPending = false;
    alarm.lastRefreshTime = Date.now();
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

  function maybeRefreshSnooze (alarm, level, group, force) {
    var isSnoozeable = ctx.levels && level >= ctx.levels.WARN && group !== ANNOUNCEMENT_GROUP;
    if (!isSnoozeable || !ctx.alarmStorage || alarm.refreshPending) return;

    var now = Date.now();
    var refreshAge = now - alarm.lastRefreshTime;
    if (!force && alarm.lastRefreshTime !== undefined &&
        refreshAge >= 0 && refreshAge < REFRESH_STALE_MS) return;

    alarm.refreshPending = true;
    alarm.pendingNotify = null;
    alarm.refreshDeadline = now + REFRESH_TIMEOUT_MS;
    alarm.lastRefreshTime = now;
    var generation = (alarm.refreshGeneration || 0) + 1;
    alarm.refreshGeneration = generation;

    alarm.refreshTimer = setTimeout(function refreshTimeout () {
      if (generation !== alarm.refreshGeneration || !alarm.refreshPending) return;
      console.warn(alarm.label + ' alarm refresh DEADLINE exceeded -- emitting from in-memory state');
      resolveRefresh(alarm, level, group, generation);
    }, REFRESH_TIMEOUT_MS);

    var read;
    try {
      read = ctx.alarmStorage.getSnooze(level, group);
    } catch (err) {
      console.warn('alarmStorage.getSnooze failed for ' + level + '-' + group + ': ' +
        (err && err.message ? err.message : String(err)));
      resolveRefresh(alarm, level, group, generation);
      return;
    }

    Promise.resolve(read).then(function (doc) {
      // A read started under an earlier generation can resolve after a local
      // ack has already invalidated it (invalidateRefresh can't cancel the
      // in-flight promise). Applying stale data here would silently resurrect
      // a snooze the local process just cleared -- gate on generation before
      // touching alarm state, not just before flushing the pending notify.
      if (generation === alarm.refreshGeneration) {
        applyStoredSnooze(alarm, doc, level, group);
      }
      resolveRefresh(alarm, level, group, generation);
    }).catch(function (err) {
      if (generation !== alarm.refreshGeneration) return;
      console.warn('alarmStorage.getSnooze failed for ' + level + '-' + group + ': ' +
        (err && err.message ? err.message : String(err)));
      resolveRefresh(alarm, level, group, generation);
    });
  }

  function getAlarm (level, group) {
    if (closed) return;
    group = group || 'default';
    var key = level + '-' + group;
    var alarm = alarms[key];
    if (!alarm) {
      var display = group === 'default' ? ctx.levels.toDisplay(level) : group + ':' + level;
      alarm = new Alarm(level, group, display);
      alarms[key] = alarm;
      // Defer first emit per (level, group) per process until storage refresh
      // resolves or REFRESH_TIMEOUT_MS elapses. INFO is not snoozeable so skip.
      maybeRefreshSnooze(alarm, level, group, true);
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
      if (alarm.refreshPending) {
        if (alarm.pendingNotify) {
          console.info(alarm.label + ' alarm: discarding pending notification because the condition cleared');
        }
        invalidateRefresh(alarm);
      }
      delete alarm.lastRefreshTime;
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

  // A newer WARN or URGENT notification for a group replaces one queued at the
  // other level, so a read that resolves late cannot play an alarm level the
  // condition has already left.
  function discardSupersededPending (notify) {
    if (!ctx.levels || notify.level < ctx.levels.WARN || notify.group === ANNOUNCEMENT_GROUP) return;
    var group = notify.group || 'default';
    for (var level = ctx.levels.WARN; level <= ctx.levels.URGENT; level++) {
      if (level === notify.level) continue;
      var other = alarms[level + '-' + group];
      if (other && other.pendingNotify) {
        console.info(other.label + ' alarm: discarding pending notification replaced by a level ' + notify.level + ' notification');
        other.pendingNotify = null;
      }
    }
  }

  function emitNotification (notify) {
    discardSupersededPending(notify);
    var alarm = getAlarm(notify.level, notify.group);
    maybeRefreshSnooze(alarm, notify.level, notify.group, false);
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
      if (alarm.pendingNotify && alarm.pendingNotify !== notify) {
        console.warn(alarm.label + ' alarm: discarding stale pendingNotify at deadline; emitting current notify');
      }
      alarm.pendingNotify = notify;
      resolveRefresh(alarm, notify.level, notify.group, alarm.refreshGeneration);
      return;
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

  notifications.ack = function ack (level, group, time, sendClear) {
    if (closed) return;
    group = group || 'default';
    var alarm = getAlarm(level, group);
    if (!alarm) {
      console.warn('Got an ack for an unknown alarm time, level:', level, ', group:', group);
      return;
    }

    if (Date.now() < alarm.lastAckTime + alarm.silenceTime) {
      console.warn('Alarm has already been snoozed, don\'t snooze it again, level:', level, ', group:', group);
      // A snooze whose write failed lives on this instance only. Acking again
      // retries the write with the same values instead of starting a new snooze.
      if (alarm.unsavedSnooze) {
        persistSnooze(alarm, level, group);
        if (level === 2) notifications.ack(1, group, time);
      }
      return;
    }

    alarm.lastAckTime = Date.now();
    alarm.silenceTime = time ? time : THIRTY_MINUTES;
    delete alarm.lastEmitTime;
    // User explicitly acked; refresh window no longer relevant for this alarm.
    invalidateRefresh(alarm);

    // Persist this snooze so other instances honor it. Ack arguments reach
    // here from the socket and REST API, so only well-formed values are shared.
    persistSnooze(alarm, level, group);

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
      Object.values(alarms).forEach(function clearAlarmRefresh (alarm) {
        invalidateRefresh(alarm);
      });
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
    // Cancel pending snooze refreshes so a timer or in-flight read can't
    // emit a deferred notification after teardown.
    Object.values(alarms).forEach(function clearAlarmRefresh (alarm) {
      invalidateRefresh(alarm);
    });
    alarms = {};
    requests = {notifies: [], snoozes: []};
  });

  return notifications();
}

module.exports = init;
