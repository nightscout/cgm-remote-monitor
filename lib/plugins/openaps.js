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
    sbx.offerProperty('openaps', function setOpenAPS ( ) {
      return openaps.analyzeData(sbx);
    });
  };

  openaps.analyzeData = function analyzeData (sbx) {
    var recentHours = 6; //TODO dia*2
    var recentMills = sbx.time - times.hours(recentHours).msecs;

    var recentData = _.filter(sbx.data.devicestatus, function (status) {
      return ('openaps' in status) && sbx.entryMills(status) <= sbx.time && sbx.entryMills(status) >= recentMills;
    });

    var prefs = openaps.getPrefs(sbx);
    var recent = moment(sbx.time).subtract(prefs.warn / 2, 'minutes');

    var result = {
      seenDevices: {}
      , lastEnacted: null
      , lastNotEnacted: null
      , lastSuggested: null
      , lastIOB: null
      , lastMMTune: null
    };

    function getDevice(status) {
      var uri = status.device || 'device';
      var device = result.seenDevices[uri];

      if (!device) {
        device = {
          name: uri.indexOf('openaps://') === 0 ? uri.substring('openaps://'.length) : uri
          , uri: uri
        };

        result.seenDevices[uri] = device;
      }
      return device;
    }

    function toMoments (status) {
      return {
        when:  moment(status.mills)
        , enacted: status.openaps.enacted && status.openaps.enacted.recieved && moment(status.openaps.enacted.timestamp)
        , notEnacted: status.openaps.enacted && !status.openaps.enacted.recieved && moment(status.openaps.enacted.timestamp)
        , suggested: status.openaps.suggested && moment(status.openaps.suggested.timestamp)
        , iob: status.openaps.iob && moment(status.openaps.iob.timestamp)
      };
    }

    function momentsToLoopStatus (moments, noWarning)  {

      var status = {
        symbol: '⚠'
        , code: 'warning'
        , label: 'Warning'
      };

      if (moments.notEnacted && moments.notEnacted.isAfter(recent)) {
        status.symbol = 'x';
        status.code = 'notenacted';
        status.label = 'Not Enacted';
      } else if (moments.enacted && moments.enacted.isAfter(recent)) {
        status.symbol = '⌁';
        status.code = 'enacted';
        status.label = 'Enacted';
      } else if (moments.suggested && moments.suggested.isAfter(recent)) {
        status.symbol = '↻';
        status.code = 'looping';
        status.label = 'Looping';
      } else if (moments.when && (noWarning || moments.when.isAfter(recent))) {
        status.symbol = '◉';
        status.code = 'waiting';
        status.label = 'Waiting';
      }

      return status;
    }

    _.forEach(recentData, function eachStatus (status) {
      var device = getDevice(status);

      var moments = toMoments(status);
      var loopStatus = momentsToLoopStatus(moments, true);

      if (!device.status || moments.when.isAfter(device.status.when)) {
        device.status = loopStatus;
        device.status.when = moments.when;
      }

      var enacted = status.openaps && status.openaps.enacted;
      if (enacted && moments.enacted && (!result.lastEnacted || moments.enacted.isAfter(result.lastEnacted.moment))) {
        enacted.moment = moment(enacted.timestamp);
        result.lastEnacted = enacted;
      }

      if (enacted && moments.notEnacted && (!result.lastNotEnacted || moments.notEnacted.isAfter(result.lastNotEnacted.moment))) {
        enacted.moment = moment(enacted.timestamp);
        result.lastNotEnacted = enacted;
      }

      var suggested = status.openaps && status.openaps.suggested;
      if (suggested && moments.suggested && (!result.lastSuggested || moments.suggested.isAfter(result.lastSuggested.moment))) {
        suggested.moment = moment(suggested.timestamp);
        result.lastSuggested = suggested;
      }

      var iob = status.openaps && status.openaps.iob;
      if (moments.iob && (!result.lastIOB || moments.iob.isAfter(result.lastIOB.moment))) {
        iob.moment = moments.iob;
        result.lastIOB = iob;
      }

      if (status.mmtune && status.mmtune.timestamp) {
        status.mmtune.moment = moment(status.mmtune.timestamp);
        if (!result.lastMMTune || status.mmtune.moment.isAfter(result.lastMMTune.moment)) {
          result.lastMMTune = status.mmtune;
        }
      }
    });

    result.lastLoopMoment = result.lastEnacted && result.lastSuggested ? moment.max(result.lastEnacted.moment, result.lastSuggested.moment) : result.lastEnacted && result.lastEnacted.moment || result.lastSuggested && result.lastSuggested.moment;

    result.status = momentsToLoopStatus({
      enacted: result.lastEnacted && result.lastEnacted.moment
      , notEnacted: result.lastNotEnacted && result.lastNotEnacted.moment
      , suggested: result.lastSuggested && result.lastSuggested.moment
    }, false, recent);

    return result;
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

    if (!prop.lastLoopMoment) {
      console.info('OpenAPS hasn\'t reported a loop yet');
      return;
    }

    var now = moment();
    var level = statusLevel(prop, prefs, sbx);
    if (level >= levels.WARN) {
      sbx.notifications.requestNotify({
        level: level
        , title: 'OpenAPS isn\'t looping'
        , message: 'Last Loop: ' + formatAgo(prop.lastLoopMoment, now.valueOf())
        , pushoverSound: 'echo'
        , plugin: openaps
        , debug: prop
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

    var prefs = openaps.getPrefs(sbx);

    function valueString (prefix, value) {
      return value ? prefix + value : '';
    }

    var events = [ ];

    function addSuggestion() {
      if (prop.lastSuggested) {

        var valueParts = [
          valueString('BG: ', prop.lastSuggested.bg)
          , valueString(', ', prop.lastSuggested.reason)
          , prop.lastSuggested.mealAssist ? ' <b>Meal Assist:</b> ' + prop.lastSuggested.mealAssist : ''
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

    if ('enacted' === prop.status.code) {
      var canceled = prop.lastEnacted.rate === 0 && prop.lastEnacted.duration === 0;

      var valueParts = [
        valueString('BG: ', prop.lastEnacted.bg)
        , ', <b>Temp Basal' + (canceled ? ' Canceled' : ' Started') + '</b>'
        , canceled ? '' : ' ' + prop.lastEnacted.rate.toFixed(2) + ' for ' + prop.lastEnacted.duration + 'm'
        , valueString(', ', prop.lastEnacted.reason)
        , prop.lastEnacted.mealAssist ? ' <b>Meal Assist:</b> ' + prop.lastEnacted.mealAssist : ''
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

    _.forIn(prop.seenDevices, function seenDevice (device) {
      events.push({
        time: device.status.when
        , value: ['update from', device.name, device.status.symbol, device.status.label].join(' ')
      });
    });

    var sorted = _.sortBy(events, function toMill(event) {
      return event.time.valueOf();
    }).reverse();

    var info = _.map(sorted, function eventToInfo (event) {
      return {
        label: timeAt(false, sbx) + timeFormat(event.time, sbx)
        , value: event.value
      };
    });

    if (prop.lastMMTune) {
      var best = _.max(prop.lastMMTune.scanDetails, function (d) {
        return d[2];
      });

      var mmtuneDetails = [prop.lastMMTune.setFreq, 'MHz'];

      if (best && best.length > 2) {
        mmtuneDetails = mmtuneDetails.concat([' @ ', best[2] + 'dB']);
      }

      info.push({label: 'mmtune', value: mmtuneDetails.join('')});
    }

    sbx.pluginBase.updatePillText(openaps, {
      value: timeFormat(prop.lastLoopMoment, sbx)
      , label: 'OpenAPS ' + prop.status.symbol
      , info: info
      , pillClass: statusClass(prop, prefs, sbx)
    });
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

    if (openaps.findOfflineMarker(sbx)) {
      console.info('OpenAPS known offline, not checking for alerts');
    } else if (prop.lastLoopMoment) {
      var urgentTime = prop.lastLoopMoment.clone().add(prefs.urgent, 'minutes');
      var warningTime = prop.lastLoopMoment.clone().add(prefs.warn, 'minutes');

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