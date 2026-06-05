'use strict';

var times = require('../times');
var selectOpenAPSState = require('../client-core/devicestatus/openaps');

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
      });

    var prefs = openaps.getPrefs(sbx);
    var recent = moment(sbx.time).subtract(prefs.warn / 2, 'minutes');

    return selectOpenAPSState(recentData, recent, {
      moment: moment
      , deviceName: utils.deviceName
    });
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
