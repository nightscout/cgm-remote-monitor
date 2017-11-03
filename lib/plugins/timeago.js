'use strict';

var levels = require('../levels');
var times = require('../times');

function init (ctx) {
  var translate = ctx.language.translate;

  var timeago = {
    name: 'timeago'
    , label: 'Timeago'
    , pluginType: 'pill-status'
    , pillFlip: true
  };

  timeago.checkNotifications = function checkNotifications (sbx) {

    if (!sbx.extendedSettings.enableAlerts) {
      return;
    }

    var lastSGVEntry = sbx.lastSGVEntry();

    if (!lastSGVEntry || lastSGVEntry.mills >= sbx.time) {
      return;
    }

    function buildMessage(agoDisplay) {
      var lines = sbx.prepareDefaultLines();
      lines.unshift(translate('Last received:') + ' ' + [agoDisplay.value, agoDisplay.label].join(' '));
      return lines.join('\n');
    }

    function sendAlarm (opts) {
      var agoDisplay = timeago.calcDisplay(lastSGVEntry, sbx.time);

      sbx.notifications.requestNotify({
        level: opts.level
        , title: translate('Stale data, check rig?')
        , message: buildMessage(agoDisplay)
        , eventName: timeago.name
        , plugin: timeago
        , group: 'Time Ago'
        , pushoverSound: opts.pushoverSound
        , debug: agoDisplay
      });
    }

    var status = timeago.checkStatus(sbx);
    if (status === 'urgent') {
      sendAlarm({
        level: levels.URGENT
        , pushoverSound: 'echo'
      });
    } else if (status === 'warn') {
      sendAlarm({
        level: levels.WARN
        , pushoverSound: 'echo'
      });
    }

  };

  timeago.checkStatus = function checkStatus (sbx) {

    var lastSGVEntry = sbx.lastSGVEntry()
      , warn = sbx.settings.alarmTimeagoWarn
      , warnMins = sbx.settings.alarmTimeagoWarnMins || 15
      , urgent = sbx.settings.alarmTimeagoUrgent
      , urgentMins = sbx.settings.alarmTimeagoUrgentMins || 30
      ;

    function isStale(mins) {
      return sbx.time - lastSGVEntry.mills > times.mins(mins).msecs;
    }

    var status = 'current';

    if (!lastSGVEntry) {
      //assume current
    } else if (urgent && isStale(urgentMins)) {
      status = 'urgent';
    } else if (warn && isStale(warnMins)) {
      status = 'warn';
    }

    return status;

  };

  timeago.isMissing = function isMissing (opts) {
    if (!opts || !opts.entry || isNaN(opts.entry.mills) || isNaN(opts.time) || isNaN(opts.timeSince)) {
      return {
        label: 'time ago'
        , shortLabel: 'ago'
      };
    }
  };

  timeago.inTheFuture = function inTheFuture (opts) {
    if (opts.entry.mills - times.mins(5).msecs > opts.time) {
      return {
        label: 'in the future'
        , shortLabel: 'future'
      };
    }
  };

  timeago.almostInTheFuture = function almostInTheFuture (opts) {
    if (opts.entry.mills > opts.time) {
      return {
        value: 1
        , label: 'min ago'
        , shortLabel: 'm'
      };
    }
  };

  timeago.isLessThan = function isLessThan (limit, divisor, label, shortLabel) {
    return function checkIsLessThan (opts) {
      if (opts.timeSince < limit) {
        return {
          value: Math.max(1, Math.round(opts.timeSince / divisor))
          , label: label
          , shortLabel: shortLabel
        };
      }
    };
  };

  timeago.resolvers = [
    timeago.isMissing
    , timeago.inTheFuture
    , timeago.almostInTheFuture
    , timeago.isLessThan(times.mins(2).msecs, times.min().msecs, 'min ago', 'm')
    , timeago.isLessThan(times.hour().msecs, times.min().msecs, 'mins ago', 'm')
    , timeago.isLessThan(times.hours(2).msecs, times.hour().msecs, 'hour ago', 'h')
    , timeago.isLessThan(times.day().msecs, times.hour().msecs, 'hours ago', 'h')
    , timeago.isLessThan(times.days(2).msecs, times.day().msecs, 'day ago', 'd')
    , timeago.isLessThan(times.week().msecs, times.day().msecs, 'days ago', 'd')
    , function ( ) { return { label: 'long ago', shortLabel: 'ago' } }
  ];

  timeago.calcDisplay = function calcDisplay (entry, time) {
    var opts = {
      time: time
      , entry: entry
    };

    if (time && entry && entry.mills) {
      opts.timeSince = time - entry.mills;
    }

    for (var i = 0; i < timeago.resolvers.length; i++) {
      var value = timeago.resolvers[i](opts);
      if (value) {
        return value;
      }
    }
  };

  timeago.updateVisualisation = function updateVisualisation (sbx) {
    var agoDisplay = timeago.calcDisplay(sbx.lastSGVEntry(), sbx.time);
    var inRetroMode = sbx.data.inRetroMode;

    sbx.pluginBase.updatePillText(timeago, {
      value: inRetroMode ? null : agoDisplay.value
      , label: inRetroMode ? translate('RETRO') : translate(agoDisplay.label)
      //no warning/urgent class when in retro mode
      , pillClass: inRetroMode ? 'current' : timeago.checkStatus(sbx)
    });
  };

  return timeago;

}

module.exports = init;