'use strict';

var _ = require('lodash');
var moment = require('moment');
var times = require('../times');
var levels = require('../levels');
var timeago = require('./timeago')();

// var ALL_STATUS_FIELDS = ['status-symbol', 'status-label', 'iob', 'freq', 'rssi']; Unused variable

function init() {

  var loop = {
    name: 'loop'
    , label: 'Loop'
    , pluginType: 'pill-status'
  };

  var firstPrefs = true;

  loop.getPrefs = function getPrefs(sbx) {

    var prefs = {
      warn: sbx.extendedSettings.warn ? sbx.extendedSettings.warn : 30
      , urgent: sbx.extendedSettings.urgent ? sbx.extendedSettings.urgent : 60
      , enableAlerts: sbx.extendedSettings.enableAlerts
    };

    if (firstPrefs) {
      firstPrefs = false;
      console.info(' Prefs:', prefs);
    }

    return prefs;
  };

  loop.setProperties = function setProperties (sbx) {
    sbx.offerProperty('loop', function setLoop ( ) {
      return loop.analyzeData(sbx);
    });
  };

  loop.analyzeData = function analyzeData (sbx) {
    var recentHours = 6;
    var recentMills = sbx.time - times.hours(recentHours).msecs;

    var recentData = _.chain(sbx.data.devicestatus)
      .filter(function (status) {
        return ('loop' in status) && sbx.entryMills(status) <= sbx.time && sbx.entryMills(status) >= recentMills;
      }).value( );

    var prefs = loop.getPrefs(sbx);
    var recent = moment(sbx.time).subtract(prefs.warn / 2, 'minutes');

    function getDisplayForStatus (status)  {

      var desc = {
        symbol: '⚠'
        , code: 'warning'
        , label: 'Warning'
      };

      if (status.failureReason || (status.enacted && !status.enacted.received)) {
        desc.symbol = 'x';
        desc.code = 'notenacted';
        desc.label = 'Error';
      } else if (status.enacted && moment(status.timestamp).isAfter(recent)) {
        desc.symbol = '⌁';
        desc.code = 'enacted';
        desc.label = 'Enacted';
      } else if (status.recommendedTempBasal && moment(status.recommendedTempBasal.timestamp).isAfter(recent)) {
        desc.symbol = '↻';
        desc.code = 'looping';
        desc.label = 'Looping';
      } else if (status.moment && status.moment.isAfter(recent)) {
        desc.symbol = '◉';
        desc.code = 'waiting';
        desc.label = 'Waiting';
      }
      return desc;
    }

    var result = {
      lastLoop: null
      , lastEnacted: null
      , lastOkMoment: null
    };

    _.forEach(recentData, function eachStatus (status) {
      if (status && status.loop && status.loop.timestamp) {
        var loop = status.loop
        loop.moment = moment(loop.timestamp);

        var enacted = loop.enacted;
        if (enacted && enacted.timestamp) {
          enacted.moment = moment(enacted.timestamp)
          if (!result.lastEnacted || enacted.moment.isAfter(result.lastEnacted.moment)) {
            result.lastEnacted = enacted;
          }
        }

        if (!result.lastLoop || loop.moment.isAfter(result.lastLoop.moment)) {
          result.lastLoop = loop
        }

        if (!loop.failureReason && (!result.lastOkMoment || status.moment.isAfter(result.lastOkMoment))) {
          result.lastOkMoment = loop.moment
        }
      }

    });

    result.display = getDisplayForStatus(result.lastLoop);

    return result;
  };

  loop.checkNotifications = function checkNotifications(sbx) {
    var prefs = loop.getPrefs(sbx);

    if (!prefs.enableAlerts) { return; }

    var prop = sbx.properties.loop;

    if (!prop.lastLoop) {
      console.info('Loop hasn\'t reported a loop yet');
      return;
    }

    var now = moment();
    var level = statusLevel(prop, prefs, sbx);
    if (level >= levels.WARN) {
      sbx.notifications.requestNotify({
        level: level
        , title: 'Loop isn\'t looping'
        , message: 'Last Loop: ' + formatAgo(prop.lastLoop.moment, now.valueOf())
        , pushoverSound: 'echo'
        , group: 'Loop'
        , plugin: loop
        , debug: prop
      });
    }
  };

  loop.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.loop;

    var prefs = loop.getPrefs(sbx);

    function valueString (prefix, value) {
      return value ? prefix + value : '';
    }

    var events = [ ];

    function addSuggestion() {
      if (prop.lastSuggested) {

        var valueParts = [
          valueString('BG: ', prop.lastSuggested.bg)
          , valueString(', ', prop.lastSuggested.reason)
        ];

        valueParts = concatIOB(valueParts);

        events.push({
          time: prop.lastSuggested.moment
          , value: valueParts.join('')
        });
      }
    }

    function concatIOB (valueParts) {
      if (prop.lastIOB) {
        var bolussnooze = prop.lastIOB.bolussnooze || prop.lastIOB.bolusiob;
        valueParts = valueParts.concat([
          ' IOB: '
          , sbx.roundInsulinForDisplayFormat(prop.lastIOB.iob) + 'U'
          , prop.lastIOB.basaliob ? ', Basal IOB ' + sbx.roundInsulinForDisplayFormat(prop.lastIOB.basaliob) + 'U' : ''
          , bolussnooze ? ', Bolus Snooze ' + sbx.roundInsulinForDisplayFormat(bolussnooze) + 'U' : ''
        ]);
      }

      return valueParts;
    }

    function getForecastPoints ( ) {
      var points = [ ];

      function toPoints (startTime, offset) {
        return  function toPoint (value, index) {
          return {
            mgdl: value
            , color: '#ff00ff'
            , mills: startTime.valueOf() + times.mins(5 * index).msecs + offset
            , noFade: true
          };
        };
      }

      if (prop.lastLoop && prop.lastLoop.predicted && prop.lastLoop.predicted.startDate) {
        var predicted = prop.lastLoop.predicted;
        var startTime = moment(predicted.startDate);
        if (predicted.values) {
          points = points.concat(_.map(predicted.values, toPoints(startTime, 0)));
        }
        // if (prop.lastPredBGs.IOB) {
        //   points = points.concat(_.map(prop.lastPredBGs.IOB, toPoints(moment, 3000)));
        // }
        // if (prop.lastPredBGs.COB) {
        //   points = points.concat(_.map(prop.lastPredBGs.COB, toPoints(moment, 7000)));
        // }
      }

      return points;
    }

    if ('enacted' === prop.display.code) {
      var canceled = prop.lastEnacted.rate === 0 && prop.lastEnacted.duration === 0;

      var valueParts = [
        valueString('BG: ', prop.lastEnacted.bg)
        , ', <b>Temp Basal' + (canceled ? ' Canceled' : ' Started') + '</b>'
        , canceled ? '' : ' ' + prop.lastEnacted.rate.toFixed(2) + ' for ' + prop.lastEnacted.duration + 'm'
        , valueString(', ', prop.lastEnacted.reason)
      ];

      if (prop.lastSuggested && prop.lastSuggested.moment.isAfter(prop.lastEnacted.moment)) {
        addSuggestion();
      } else {
        valueParts = concatIOB(valueParts);
      }

      events.push({
        time: prop.lastEnacted.moment
        , value: valueParts.join('')
      });
    } else {
      addSuggestion();
    }

    var sorted = _.sortBy(events, function toMill(event) {
      return event.time.valueOf();
    }).reverse();

    var info = _.map(sorted, function eventToInfo (event) {
      return {
        label: timeAt(false, sbx) + timeFormat(event.time, sbx)
        , value: event.value
      };
    });

    var label = 'Loop ' + prop.display.symbol;

    sbx.pluginBase.updatePillText(loop, {
      value: timeFormat(prop.lastLoop.moment, sbx)
      , label: label
      , info: info
      , pillClass: statusClass(prop, prefs, sbx)
    });

    var forecastPoints = getForecastPoints();
    if (forecastPoints && forecastPoints.length > 0) {
      sbx.pluginBase.addForecastPoints(forecastPoints, {type: 'loop', label: 'Loop Forecasts'});
    }
  };

  function statusClass (prop, prefs, sbx) {
    var level = statusLevel(prop, prefs, sbx);
    var cls = 'current';

    if (level === levels.WARN) {
      cls = 'warn';
    } else if (level === levels.URGENT) {
      cls = 'urgent';
    }

    return cls;
  }

  function statusLevel (prop, prefs, sbx) {
    var level = levels.NONE;
    var now = moment(sbx.time);

    if (prop.lastOkMoment) {
      var urgentTime = prop.lastOkMoment.clone().add(prefs.urgent, 'minutes');
      var warningTime = prop.lastOkMoment.clone().add(prefs.warn, 'minutes');

      if (urgentTime.isBefore(now)) {
        level = levels.URGENT;
      } else if (warningTime.isBefore(now)) {
        level = levels.WARN;
      }
    }

    return level;
  }

  return loop;

}

function timeFormat (m, sbx) {

  var when;
  if (m && sbx.data.inRetroMode) {
    when = m.format('LT');
  } else if (m) {
    when = formatAgo(m, sbx.time);
  } else {
    when = 'unknown';
  }

  return when;
}

function formatAgo (m, nowMills) {
  var ago = timeago.calcDisplay({mills: m.valueOf()}, nowMills);
  return (ago.value ? ago.value : '') + ago.shortLabel + (ago.shortLabel.length === 1 ? ' ago' : '');
}

function timeAt (prefix, sbx) {
  return sbx.data.inRetroMode ? (prefix ? ' ' : '') + '@ ' : (prefix ? ', ' : '');
}

module.exports = init;
