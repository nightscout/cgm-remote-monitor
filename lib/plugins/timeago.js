'use strict';

var levels = require('../levels');
var times = require('../times');

function init ( ) {

  var timeago = {
    name: 'timeago'
    , label: 'Timeago'
    , pluginType: 'notification'
  };

  timeago.checkNotifications = function checkNotifications (sbx) {
    var lastSGVEntry = sbx.lastSGVEntry()
      , warn = 'off' !== sbx.extendedSettings.warn
      , warnMins = sbx.extendedSettings.warnMins || 15
      , urgent = 'off' !== sbx.extendedSettings.urgent
      , urgentMins = sbx.extendedSettings.urgentMins || 30
      ;

    if (!lastSGVEntry || lastSGVEntry.mills >= sbx.time) {
      return;
    }

    function isStale (mins) {
      return sbx.time - lastSGVEntry.mills > times.mins(mins).msecs;
    }

    function buildMessage(agoDisplay) {
      var lines = sbx.prepareDefaultLines();
      lines.unshift('Last received: ' + [agoDisplay.value, agoDisplay.label].join(' '));
      return lines.join('\n');
    }

    function sendAlarm (opts) {
      var agoDisplay = timeago.calcDisplay(lastSGVEntry, sbx.time);

      sbx.notifications.requestNotify({
        level: opts.level
        , title: 'Stale data, check rig?'
        , message: buildMessage(agoDisplay)
        , eventName: timeago.name
        , plugin: timeago
        , pushoverSound: opts.pushoverSound
        , debug: agoDisplay
      });
    }

    if (urgent && isStale(urgentMins)) {
      sendAlarm({
        level: levels.URGENT
        , pushoverSound: 'siren'
      });
    } else if (warn && isStale(warnMins)) {
      sendAlarm({
        level: levels.WARN
        , pushoverSound: 'echo'
      });
    }

  };

  timeago.isMissing = function isMissing (opts) {
    if (!opts || !opts.entry || isNaN(opts.entry.mills) || isNaN(opts.time) || isNaN(opts.timeSince)) {
      return {
        label: 'time ago'
      };
    }
  };

  timeago.inTheFuture = function inTheFuture (opts) {
    if (opts.entry.mills - times.mins(5).msecs > opts.time) {
      return {
        label: 'in the future'
      };
    }
  };

  timeago.almostInTheFuture = function almostInTheFuture (opts) {
    if (opts.entry.mills > opts.time) {
      return {
        value: 1
        , label: 'min ago'
      };
    }
  };

  timeago.isLessThan = function isLessThan (limit, divisor, label) {
    return function checkIsLessThan (opts) {
      if (opts.timeSince < limit) {
        return {
          value: Math.max(1, Math.round(opts.timeSince / divisor))
          , label: label
        };
      }
    }
  };

  timeago.resolvers = [
    timeago.isMissing
    , timeago.inTheFuture
    , timeago.almostInTheFuture
    , timeago.isLessThan(times.mins(2).msecs, times.min().msecs, 'min ago')
    , timeago.isLessThan(times.hour().msecs, times.min().msecs, 'mins ago')
    , timeago.isLessThan(times.hours(2).msecs, times.hour().msecs, 'hour ago')
    , timeago.isLessThan(times.day().msecs, times.hour().msecs, 'hours ago')
    , timeago.isLessThan(times.days(2).msecs, times.day().msecs, 'day ago')
    , timeago.isLessThan(times.week().msecs, times.day().msecs, 'days ago')
    , function ( ) { return { label: 'long ago' } }
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

  return timeago;

}

module.exports = init;