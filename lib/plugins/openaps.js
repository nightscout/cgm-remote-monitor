'use strict';

var times = require('../times');

// var ALL_STATUS_FIELDS = ['status-symbol', 'status-label', 'iob', 'meal-assist', 'freq', 'rssi']; Unused variable

function init (ctx) {
  var moment = ctx.moment;
  var utils = require('../utils')(ctx);
  var openaps = {
    name: 'openaps'
    , label: 'OpenAPS'
    , pluginType: 'pill-status'
  };
  var translate = ctx.language.translate;
  var firstPrefs = true;
  var levels = ctx.levels;

  openaps.getClientPrefs = function getClientPrefs() {
    return ([{
      label: "Color prediction lines",
      id: "colorPredictionLines",
      type: "boolean"
    }]);
  }

  openaps.getPrefs = function getPrefs (sbx) {

    function cleanList (value) {
      return decodeURIComponent(value || '').toLowerCase().split(' ');
    }

    function isEmpty (list) {
      return utils.isEmpty(list) || utils.isEmpty(list?.[0]);
    }

    const settings = sbx.extendedSettings || {};

    var fields = cleanList(settings.fields);
    fields = isEmpty(fields) ? ['status-symbol', 'status-label', 'iob', 'meal-assist', 'rssi'] : fields;

    var retroFields = cleanList(settings.retroFields);
    retroFields = isEmpty(retroFields) ? ['status-symbol', 'status-label', 'iob', 'meal-assist', 'rssi'] : retroFields;

    if (typeof settings.colorPredictionLines == 'undefined') {
      settings.colorPredictionLines = true;
    }

    var prefs = {
      fields: fields
      , retroFields: retroFields
      , warn: settings.warn ? settings.warn : 30
      , urgent: settings.urgent ? settings.urgent : 60
      , enableAlerts: settings.enableAlerts
      , predIOBColor: settings.predIobColor ? settings.predIobColor : '#1e88e5'
      , predCOBColor: settings.predCobColor ? settings.predCobColor : '#FB8C00'
      , predACOBColor: settings.predAcobColor ? settings.predAcobColor : '#FB8C00'
      , predZTColor: settings.predZtColor ? settings.predZtColor : '#00d2d2'
      , predUAMColor: settings.predUamColor ? settings.predUamColor : '#c9bd60'
      , colorPredictionLines: settings.colorPredictionLines
    };

    if (firstPrefs) {
      firstPrefs = false;
    }

    return prefs;
  };

  openaps.setProperties = function setProperties (sbx) {
    sbx.offerProperty('openaps', function setOpenAPS () {
      return openaps.analyzeData(sbx);
    });
  };

  openaps.analyzeData = function analyzeData (sbx) {
    var recentHours = 6; //TODO dia*2
    var recentMills = sbx.time - times.hours(recentHours).msecs;
    var recentData = sbx.data.devicestatus
      .filter(function(status) {
        return ('openaps' in status) && sbx.entryMills(status) <= sbx.time && sbx.entryMills(status) >= recentMills;
      })
      .map(function(status) {
        if (status.openaps && Array.isArray(status.openaps.iob) && status.openaps.iob.length > 0) {
          status.openaps.iob = status.openaps.iob[0];
          if (status.openaps.iob.time) {
            status.openaps.iob.timestamp = status.openaps.iob.time;
          }
        }
        return status;
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
      , lastPredBGs: null
    };

    function getDevice (status) {
      var uri = status.device || 'device';
      var device = result.seenDevices[uri];

      if (!device) {
        device = {
          name: utils.deviceName(uri)
          , uri: uri
        };

        result.seenDevices[uri] = device;
      }
      return device;
    }

    function toMoments (status) {
      var enacted = false;
      var notEnacted = false;
      if (status.openaps.enacted && status.openaps.enacted.timestamp && (status.openaps.enacted.recieved || status.openaps.enacted.received)) {
        if (status.openaps.enacted.mills) {
          enacted = moment(status.openaps.enacted.mills);
        } else {
          enacted = moment(status.openaps.enacted.timestamp);
        }
      } else if (status.openaps.enacted && status.openaps.enacted.timestamp && !(status.openaps.enacted.recieved || status.openaps.enacted.received)) {
        if (status.openaps.enacted.mills) {
          notEnacted = moment(status.openaps.enacted.mills)
        } else {
          notEnacted = moment(status.openaps.enacted.timestamp)
        }
      }

      var suggested = false;
      if (status.openaps.suggested && status.openaps.suggested.mills) {
        suggested = moment(status.openaps.suggested.mills);
      } else if (status.openaps.suggested && status.openaps.suggested.timestamp) {
        suggested = moment(status.openaps.suggested.timestamp);
      }

      var iob = false;
      if (status.openaps.iob && status.openaps.iob.mills) {
        iob = moment(status.openaps.iob.mills);
      } else if (status.openaps.iob && status.openaps.iob.timestamp) {
        iob = moment(status.openaps.iob.timestamp);
      }

      return {
        when: moment(status.mills)
        , enacted
        , notEnacted
        , suggested
        , iob
      };
    }

    function momentsToLoopStatus (moments, noWarning) {

      var status = {
        symbol: '⚠'
        , code: 'warning'
        , label: 'Warning'
      };

      if (moments.notEnacted && (
          (moments.enacted && moments.notEnacted.isAfter(moments.enacted)) || (!moments.enacted && moments.notEnacted.isAfter(recent)))) {
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
    recentData.forEach(function eachStatus (status) {
      var device = getDevice(status);

      var moments = toMoments(status);
      var loopStatus = momentsToLoopStatus(moments, true);

      if (!device.status || moments.when.isAfter(device.status.when)) {
        device.status = loopStatus;
        device.status.when = moments.when;
      }

      var enacted = status.openaps && status.openaps.enacted;
      if (enacted && moments.enacted && (!result.lastEnacted || moments.enacted.isAfter(result.lastEnacted.moment))) {
        if (enacted.mills) {
          enacted.moment = moment(enacted.mills);
        } else {
          enacted.moment = moment(enacted.timestamp);
        }
        result.lastEnacted = enacted;
        if (enacted.predBGs && (!result.lastPredBGs || enacted.moment.isAfter(result.lastPredBGs.moment))) {
          result.lastPredBGs = Array.isArray(enacted.predBGs) ? { values: enacted.predBGs } : enacted.predBGs;
          result.lastPredBGs.moment = enacted.moment;
        }
      }

      if (enacted && moments.notEnacted && (!result.lastNotEnacted || moments.notEnacted.isAfter(result.lastNotEnacted.moment))) {
        if (enacted.mills) {
          enacted.moment = moment(enacted.mills);
        } else {
          enacted.moment = moment(enacted.timestamp);
        }
        result.lastNotEnacted = enacted;
      }

      var suggested = status.openaps && status.openaps.suggested;
      if (suggested && moments.suggested && (!result.lastSuggested || moments.suggested.isAfter(result.lastSuggested.moment))) {
        if (suggested.mills) {
          suggested.moment = moment(suggested.mills);
        } else {
          suggested.moment = moment(suggested.timestamp);
        }
        result.lastSuggested = suggested;
        if (suggested.predBGs && (!result.lastPredBGs || suggested.moment.isAfter(result.lastPredBGs.moment))) {
          result.lastPredBGs = Array.isArray(suggested.predBGs) ? { values: suggested.predBGs } : suggested.predBGs;
          result.lastPredBGs.moment = suggested.moment;
        }
      }

      var iob = status.openaps && status.openaps.iob;
      if (moments.iob && (!result.lastIOB || moment(iob.timestamp).isAfter(result.lastIOB.moment))) {
        iob.moment = moments.iob;
        result.lastIOB = iob;
      }

      if (status.mmtune && status.mmtune.timestamp) {
        status.mmtune.moment = moment(status.mmtune.timestamp);
        if (!device.mmtune || moments.when.isAfter(device.mmtune.moment)) {
          device.mmtune = status.mmtune;
        }
      }
    });

    if (result.lastEnacted && result.lastSuggested) {
      if (result.lastEnacted.moment.isAfter(result.lastSuggested.moment)) {
        result.lastLoopMoment = result.lastEnacted.moment;
        result.lastEventualBG = result.lastEnacted.eventualBG;
      } else {
        result.lastLoopMoment = result.lastSuggested.moment;
        result.lastEventualBG = result.lastSuggested.eventualBG;
      }
    } else if (result.lastEnacted && result.lastEnacted.moment) {
      result.lastLoopMoment = result.lastEnacted.moment;
      result.lastEventualBG = result.lastEnacted.eventualBG;
    } else if (result.lastSuggested && result.lastSuggested.moment) {
      result.lastLoopMoment = result.lastSuggested.moment;
      result.lastEventualBG = result.lastSuggested.eventualBG;
    }

    result.status = momentsToLoopStatus({
      enacted: result.lastEnacted && result.lastEnacted.moment
      , notEnacted: result.lastNotEnacted && result.lastNotEnacted.moment
      , suggested: result.lastSuggested && result.lastSuggested.moment
    }, false, recent);

    return result;
  };

  openaps.getEventTypes = function getEventTypes (sbx) {

    var units = sbx.settings.units;
    console.log('units', units);

    var reasonconf = [];

    if (units == 'mmol') {
      reasonconf.push({ name: translate('Eating Soon'), targetTop: 4.5, targetBottom: 4.5, duration: 60 });
      reasonconf.push({ name: translate('Activity'), targetTop: 8, targetBottom: 6.5, duration: 120 });
    } else {
      reasonconf.push({ name: translate('Eating Soon'), targetTop: 80, targetBottom: 80, duration: 60 });
      reasonconf.push({ name: translate('Activity'), targetTop: 140, targetBottom: 120, duration: 120 });
    }

    reasonconf.push({ name: 'Manual' });

    return [
      {
        val: 'Temporary Target'
        , name: 'Temporary Target'
        , bg: false
        , insulin: false
        , carbs: false
        , prebolus: false
        , duration: true
        , percent: false
        , absolute: false
        , profile: false
        , split: false
        , targets: true
        , reasons: reasonconf
      }
      , {
        val: 'Temporary Target Cancel'
        , name: 'Temporary Target Cancel'
        , bg: false
        , insulin: false
        , carbs: false
        , prebolus: false
        , duration: false
        , percent: false
        , absolute: false
        , profile: false
        , split: false
      }
      , {
        val: 'OpenAPS Offline'
        , name: 'OpenAPS Offline'
        , bg: false
        , insulin: false
        , carbs: false
        , prebolus: false
        , duration: true
        , percent: false
        , absolute: false
        , profile: false
        , split: false
      }
    ];
  };

  openaps.checkNotifications = function checkNotifications (sbx) {
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
        , message: 'Last Loop: ' + utils.formatAgo(prop.lastLoopMoment, now.valueOf())
        , pushoverSound: 'echo'
        , group: 'OpenAPS'
        , plugin: openaps
        , debug: prop
      });
    }
  };
  openaps.findOfflineMarker = function findOfflineMarker (sbx) {
    if (!sbx.data || !sbx.data.treatments) {
      return null;
    }
    return sbx.data.treatments.slice().reverse().find(function match (treatment) {
      var eventTime = sbx.entryMills(treatment);
      var eventEnd = treatment.duration ? eventTime + times.mins(treatment.duration).msecs : eventTime;
      return eventTime <= sbx.time && treatment.eventType === 'OpenAPS Offline' && eventEnd >= sbx.time;
    });
  };

  openaps.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.openaps;

    var prefs = openaps.getPrefs(sbx);

    var selectedFields = sbx.data.inRetroMode ? prefs.retroFields : prefs.fields;

    function valueString (prefix, value) {
      return value ? prefix + value : '';
    }

    function displayBg (bg) {
      return sbx.roundBGToDisplayFormat(sbx.scaleMgdl(bg));
    }

    var events = [];

    function addSuggestion () {
      if (prop.lastSuggested) {
        var bg = displayBg(prop.lastSuggested.bg);

        var valueParts = [
          valueString('BG: ', bg)
          , valueString(', ', prop.lastSuggested.reason)
          , prop.lastSuggested.sensitivityRatio ? ', <b>Sensitivity Ratio:</b> ' + prop.lastSuggested.sensitivityRatio : ''
        ];
        if (selectedFields?.includes('iob')) {
          valueParts = concatIOB(valueParts);
        }

        events.push({
          time: prop.lastSuggested.moment
          , value: valueParts.join('')
        });
      }
    }

    function concatIOB (valueParts) {
      if (prop.lastIOB) {
        valueParts = valueParts.concat([
          ', IOB: '
          , sbx.roundInsulinForDisplayFormat(prop.lastIOB.iob) + 'U'
          , prop.lastIOB.basaliob ? ', Basal IOB ' + sbx.roundInsulinForDisplayFormat(prop.lastIOB.basaliob) + 'U' : ''
          , prop.lastIOB.bolusiob ? ', Bolus IOB ' + sbx.roundInsulinForDisplayFormat(prop.lastIOB.bolusiob) + 'U' : ''
        ]);
      }

      return valueParts;
    }

    function getForecastPoints () {
      var points = [];

      function toPoints (offset, forecastType) {
        return function toPoint (value, index) {
          var colors = {
            'Values': '#ff00ff'
            , 'IOB': prefs.predIOBColor
            , 'Zero-Temp': prefs.predZTColor
            , 'COB': prefs.predCOBColor
            , 'Accel-COB': prefs.predACOBColor
            , 'UAM': prefs.predUAMColor
          }

          return {
            mgdl: value
            , color: prefs.colorPredictionLines ? colors[forecastType] : '#ff00ff'
            , mills: prop.lastPredBGs.moment.valueOf() + times.mins(5 * index).msecs + offset
            , noFade: true
            , forecastType: forecastType
          };
        };
      }
      if (prop.lastPredBGs) {
        if (prop.lastPredBGs.values) {
          points = points.concat(prop.lastPredBGs.values.map(toPoints(0, "Values")));
        }
        if (prop.lastPredBGs.IOB) {
          points = points.concat(prop.lastPredBGs.IOB.map(toPoints(3333, "IOB")));
        }
        if (prop.lastPredBGs.ZT) {
          points = points.concat(prop.lastPredBGs.ZT.map(toPoints(4444, "Zero-Temp")));
        }
        if (prop.lastPredBGs.aCOB) {
          points = points.concat(prop.lastPredBGs.aCOB.map(toPoints(5555, "Accel-COB")));
        }
        if (prop.lastPredBGs.COB) {
          points = points.concat(prop.lastPredBGs.COB.map(toPoints(7777, "COB")));
        }
        if (prop.lastPredBGs.UAM) {
          points = points.concat(prop.lastPredBGs.UAM.map(toPoints(9999, "UAM")));
        }
      }

      return points;
    }

    if ('enacted' === prop.status.code) {
      var rawBasalRate = prop.lastEnacted.rate;
      var rawDuration = prop.lastEnacted.duration;
      var basalRate = Number(rawBasalRate);
      var duration = Number(rawDuration);
      var hasBasalRate = rawBasalRate !== undefined && rawBasalRate !== null && rawBasalRate !== '' && Number.isFinite(basalRate);
      var hasDuration = rawDuration !== undefined && rawDuration !== null && rawDuration !== '' && Number.isFinite(duration);
      var hasTempBasalDetails = hasBasalRate && hasDuration;
      var canceled = hasTempBasalDetails && basalRate === 0 && duration === 0;
      var bg = displayBg(prop.lastEnacted.bg);

      var valueParts = [
        valueString('BG: ', bg)
      ];
      if (canceled || hasTempBasalDetails) {
        valueParts.push(', <b>Temp Basal' + (canceled ? ' Canceled' : ' Started') + '</b>');
        if (!canceled) {
          valueParts.push(' ' + basalRate.toFixed(2) + ' for ' + duration + 'm');
        }
      }
      valueParts.push(
        valueString(', ', prop.lastEnacted.reason)
        , prop.lastEnacted.mealAssist && selectedFields?.includes('meal-assist') ? ' <b>Meal Assist:</b> ' + prop.lastEnacted.mealAssist : ''
      );

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
     Object.values(prop.seenDevices).forEach((device) => {
      var deviceInfo = [device.name];
      if (selectedFields?.includes('status-symbol')) {
        deviceInfo.push(device.status.symbol);
      }

      if (selectedFields?.includes('status-label')) {
        deviceInfo.push(device.status.label);
      }

      if (device.mmtune) {
        var best = device.mmtune.scanDetails.length > 0
          ? device.mmtune.scanDetails.reduce((max, current) => {
              return (!max || (current?.[2] || 0) > (max?.[2] || 0)) ? current : max;
            }, null)
          : null;
        if (selectedFields?.includes('freq')) {
          deviceInfo.push(device.mmtune.setFreq + 'MHz');
        }
        if (best && best.length > 2 && selectedFields?.includes('rssi')) {
          deviceInfo.push('@ ' + best[2] + 'dB');
        }
      }
      events.push({
        time: device.status.when
        , value: deviceInfo.join(' ')
      });
    });
    var sorted = events.sort((a, b) => b.time.valueOf() - a.time.valueOf());
    var info = sorted.map(function eventToInfo (event) {
      return {
        label: utils.timeAt(false, sbx) + utils.timeFormat(event.time, sbx)
        , value: event.value
      };
    });

    var label = 'OpenAPS';    if (selectedFields?.includes('status-symbol')) {
      label += ' ' + prop.status.symbol;
    }

    sbx.pluginBase.updatePillText(openaps, {
      value: utils.timeFormat(prop.lastLoopMoment, sbx)
      , label: label
      , info: info
      , pillClass: statusClass(prop, prefs, sbx)
    });

    var forecastPoints = getForecastPoints();
    if (forecastPoints && forecastPoints.length > 0) {
      sbx.pluginBase.addForecastPoints(forecastPoints, { type: 'openaps', label: 'OpenAPS Forecasts' });
    }
  };
  function virtAsstForecastHandler (next, slots, sbx) {
    var lastEventualBG = sbx?.properties?.openaps?.lastEventualBG;
    if (lastEventualBG) {
      var response = translate('virtAsstOpenAPSForecast', {
        params: [
          lastEventualBG
        ]
      });
      next(translate('virtAsstTitleOpenAPSForecast'), response);
    } else {
      next(translate('virtAsstTitleOpenAPSForecast'), translate('virtAsstUnknown'));
    }
  }

  function virtAsstLastLoopHandler (next, slots, sbx) {
    var lastLoopMoment = sbx?.properties?.openaps?.lastLoopMoment;
    if (lastLoopMoment) {
      var response = translate('virtAsstLastLoop', {
        params: [
          moment(lastLoopMoment).from(moment(sbx.time))
        ]
      });
      next(translate('virtAsstTitleLastLoop'), response);
    } else {
      next(translate('virtAsstTitleLastLoop'), translate('virtAsstUnknown'));
    }
  }

  openaps.virtAsst = {
    intentHandlers: [{
      intent: 'MetricNow'
      , metrics: ['openaps forecast', 'forecast']
      , intentHandler: virtAsstForecastHandler
    }, {
      intent: 'LastLoop'
      , intentHandler: virtAsstLastLoopHandler
    }]
  };

  function statusClass (prop, prefs, sbx) {
    var level = statusLevel(prop, prefs, sbx);
    return levels.toStatusClass(level);
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

module.exports = init;
