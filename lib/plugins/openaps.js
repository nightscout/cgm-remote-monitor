'use strict';

var _ = require('lodash');
var moment = require('moment');
var times = require('../times');
var levels = require('../levels');
var timeago = require('./timeago')();

function init() {

  var openaps = {
    name: 'openaps'
    , label: 'OpenAPS'
    , pluginType: 'pill-status'
  };

  openaps.getPrefs = function getPrefs(sbx) {
    return {
      warn: sbx.extendedSettings.warn ? sbx.extendedSettings.warn : 30,
      urgent: sbx.extendedSettings.urgent ? sbx.extendedSettings.urgent : 60,
      enableAlerts: sbx.extendedSettings.enableAlerts
    };
  };

  openaps.setProperties = function setProperties (sbx) {
    sbx.offerProperty('openaps', function setopenaps ( ) {
      var openapsStatus = _.findLast(sbx.data.devicestatus, function (status) {
        return sbx.entryMills(status) <= sbx.time && ('openaps' in status);
      });

      var loopStatus = checkLoopStatus(openapsStatus, sbx);
      openapsStatus = openapsStatus || {};
      openapsStatus.status = loopStatus;

      return openapsStatus;
    });
  };

  openaps.getEventTypes = function getEventTypes ( ) {
    return [
      {
        val: 'OpenAPS Offline'
        , name: 'OpenAPS Offline'
        , bg: false, insulin: false, carbs: false, prebolus: false, duration: true, percent: false, absolute: false, profile: false, split: false
      }
    ];
  };

  openaps.checkNotifications = function checkNotifications(sbx) {
    var prefs = openaps.getPrefs(sbx);

    if (!prefs.enableAlerts) { return; }

    var prop = sbx.properties.openaps;
    var ops = prepOps(prop, sbx);

    if (!ops.lastLoopTime) {
      console.info('OpenAPS hasn\'t reported a loop yet');
      return;
    }

    var now = moment();
    var level = statusLevel(ops, prefs, sbx);
    if (level >= levels.WARN) {
      sbx.notifications.requestNotify({
        level: level
        , title: 'OpenAPS isn\'t looping'
        , message: 'Last Loop: ' + formatAgo(ops.lastLoopTime, now.valueOf())
        , pushoverSound: 'echo'
        , plugin: openaps
        , debug: ops
      });
    }
  };

  openaps.findOfflineMarker = function findOfflineMarker(sbx) {
    return _.findLast(sbx.data.treatments, function match(treatment) {
      var eventTime = sbx.entryMills(treatment);
      var eventEnd = treatment.duration ? eventTime + times.mins(treatment.duration).msecs : eventTime;
      return eventTime <= sbx.time && treatment.eventType === 'OpenAPS Offline' && eventEnd >= sbx.time;
    });
  };

  openaps.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.openaps;

    var info = [];

    info.push({label: timeFormat(prop.status.when, sbx), value: prop.status.label});

    var ops = prepOps(prop, sbx);
    var prefs = openaps.getPrefs(sbx);

    function valueString (prefix, value) {
      return value ? prefix + value : '';
    }

    function addSuggestion() {
      info.push({
        label: timeAt(false, sbx) + timeFormat(ops.suggestedTime, sbx)
        , value: [
          valueString('BG: ', ops.suggested.bg)
          , valueString(', ', ops.suggested.reason)
          , ops.suggested.mealAssist ? ' <b>Meal Assist:</b> ' + ops.suggested.mealAssist : ''
        ].join('')
      });
    }

    if ('enacted' === prop.status.code) {
      if (ops.suggestedTime.isAfter(ops.enactedTime)) {
        addSuggestion();
      }
      var canceled = ops.enacted.rate === 0 && ops.enacted.duration === 0;
      info.push({
        label: timeAt(false, sbx) + timeFormat(ops.enactedTime, sbx)
        , value: [
          valueString('BG: ', ops.enacted.bg)
          , ', <b>Temp Basal' + (canceled ? ' Canceled' : ' Started') + '</b>'
          , canceled ? '' : ' ' + ops.enacted.rate.toFixed(2) + ' for ' + ops.enacted.duration + 'm'
          , valueString(', ', ops.enacted.reason)
          , ops.enacted.mealAssist ? ' <b>Meal Assist:</b> ' + ops.enacted.mealAssist : ''
        ].join('')
      });
    } else if ('notenacted' === prop.status.code) {
      addSuggestion();
    } else if ('looping' === prop.status.code) {
      addSuggestion();
    } else if (ops.lastLoopTime) {
      info.push({
        label: timeAt(false, sbx) + timeFormat(ops.lastLoopTime, sbx)
        , value: 'Last Loop'
      });
    }

    if (ops.iob && ops.iobTime.isAfter(ops.recent)) {
      var bolussnooze = ops.iob.bolussnooze || ops.iob.bolusiob;
      info.push({
        label: 'IOB'
        , value: [
          sbx.roundInsulinForDisplayFormat(ops.iob.iob) + 'U'
          , ops.iob.basaliob ? ', Basal IOB ' + sbx.roundInsulinForDisplayFormat(ops.iob.basaliob) + 'U' : ''
          , bolussnooze ? ', Bolus Snooze ' + sbx.roundInsulinForDisplayFormat(bolussnooze) + 'U' : ''
          , timeAt(true, sbx) + timeFormat(ops.iobTime, sbx)
        ].join('')
      });
    }

    sbx.pluginBase.updatePillText(openaps, {
      value: timeFormat(ops.lastLoopTime, sbx)
      , label: 'OpenAPS ' + prop.status.symbol
      , info: info
      , pillClass: statusClass(ops, prefs, sbx)
    });
  };

  function statusClass (ops, prefs, sbx) {
    var level = statusLevel(ops, prefs, sbx);
    var cls = 'current';

    if (level === levels.WARN) {
      cls = 'warn';
    } else if (level === levels.URGENT) {
      cls = 'urgent';
    }

    return cls;
  }

  function statusLevel (ops, prefs, sbx) {
    var level = levels.NONE;
    var now = moment(sbx.time);

    if (openaps.findOfflineMarker(sbx)) {
      console.info('OpenAPS known offline, not checking for alerts');
    } else if (ops.lastLoopTime) {
      var urgentTime = ops.lastLoopTime.clone().add(prefs.urgent, 'minutes');
      var warningTime = ops.lastLoopTime.clone().add(prefs.warn, 'minutes');


      if (urgentTime.isBefore(now)) {
        level = levels.URGENT;
      } else if (warningTime.isBefore(now)) {
        level = levels.WARN;
      }
    }

    return level;
  }

  return openaps;

}

function checkLoopStatus (openapsStatus, sbx)  {

  var status = {
    symbol: '⚠'
    , code: 'warning'
    , label: 'Warning'
  };

  if (openapsStatus) {
    var enactedLast = openapsStatus.openaps.enacted && openapsStatus.openaps.enacted.recieved && moment(openapsStatus.openaps.enacted.timestamp);
    var notEnactedLast = openapsStatus.openaps.enacted && !openapsStatus.openaps.enacted.recieved && moment(openapsStatus.openaps.enacted.timestamp);
    var suggestedLast = openapsStatus.openaps.suggested && moment(openapsStatus.openaps.suggested.timestamp);

    var last =  moment(openapsStatus.mills);
    var recent = moment(sbx.time).subtract(15, 'minutes');

    if (notEnactedLast && notEnactedLast.isAfter(recent)) {
      status.symbol = 'x';
      status.code = 'notenacted';
      status.label = 'Not Enacted';
    } else if (enactedLast && enactedLast.isAfter(recent)) {
      status.symbol = '⌁';
      status.code = 'enacted';
      status.label = 'Enacted';
    } else if (suggestedLast && suggestedLast.isAfter(recent)) {
      status.symbol = '↻';
      status.code = 'looping';
      status.label = 'Looping';
    } else if (last && last.isAfter(recent)) {
      status.symbol = '◉';
      status.code = 'waiting';
      status.label = 'Waiting';
    }

    status.when = last;
  }

  return status;
}

function prepOps (prop, sbx) {

  var recent = moment(sbx.time).subtract(15, 'minutes');
  var iob = prop.openaps && prop.openaps.iob;
  var pump = prop.pump;
  var suggested = prop.openaps && prop.openaps.suggested;
  var suggestedTime = suggested && moment(suggested.timestamp);

  var enacted = null;
  var notEnacted = null;

  if (prop.openaps && prop.openaps.enacted && prop.openaps.enacted.recieved) {
    enacted = prop.openaps.enacted;
  }

  if (prop.openaps && !prop.openaps.enacted && prop.openaps.enacted.recieved) {
    notEnacted = prop.openaps.enacted;
  }

  var enactedTime = enacted && moment(enacted.timestamp);
  var notEnactedTime = notEnacted && moment(notEnacted.timestamp);

  return {
    recent: recent
    , suggested: suggested
    , suggestedTime: suggestedTime
    , enacted: enacted
    , enactedTime: enactedTime
    , notEnacted: notEnacted
    , notEnactedTime: notEnactedTime
    , iob: iob
    , iobTime: iob && moment(iob.timestamp)
    , pump: pump
    , pumpTime: pump && pump.clock && moment(pump.clock)
    , lastLoopTime: suggestedTime && enactedTime ? moment.max(suggestedTime, enactedTime) : enactedTime || suggestedTime
  };
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