'use strict';

var _ = require('lodash');
var rawbg = require('./rawbg')();

var BG_REF = 140; //Central tendency
var BG_MIN = 36; //Not 39, but why?
var BG_MAX = 400;
var WARN_THRESHOLD = 0.05;
var URGENT_THRESHOLD = 0.10;

var AR_CONE = [-0.723, 1.716];

var ONE_HOUR = 3600000;
var ONE_MINUTE = 60000;
var FIVE_MINUTES = 300000;
var TEN_MINUTES =  600000;

function init() {

  function ar2() {
    return ar2;
  }

  ar2.label = 'AR2';
  ar2.pluginType = 'forecast';

  ar2.setProperties = function setProperties (sbx) {
    sbx.offerProperty('ar2', function setAR2 ( ) {

      var prop = {
        forecast: ar2.forecast(sbx.data.sgvs)
        , rawForecast: rawForecast(sbx.data.sgvs, sbx)
      };

      var result = checkForecast(prop.forecast, sbx) || checkForecast(prop.rawForecast, sbx, true);

      if (result) {
        prop.level = result.level;
        prop.eventName = result.eventName;
      }

      prop.usingRaw = result && result.usingRaw || false;

      var predicted = prop.usingRaw ? prop.rawForecast && prop.rawForecast.predicted : prop.forecast && prop.forecast.predicted;
      var scaled = predicted && _.map(predicted, function(p) { return sbx.scaleBg(p.y) } );

      if (scaled && scaled.length >= 3) {
        prop.displayLine = (prop.usingRaw ? 'Raw BG' : 'BG') + ' 15m: ' + scaled[2] + ' ' + sbx.unitsLabel;
      }


      return prop;
    });
  };

  ar2.checkNotifications = function checkNotifications(sbx) {
    if (Date.now() - sbx.lastSGVMills() > TEN_MINUTES) {
      return;
    }

    var prop = sbx.properties.ar2;

    if (prop) {
      sbx.notifications.requestNotify({
        level: prop.level
        , title: buildTitle(prop, sbx)
        , message: sbx.buildDefaultMessage()
        , eventName: prop.eventName
        , pushoverSound: pushoverSound(prop, sbx)
        , plugin: ar2
        , debug: buildDebug(prop, sbx)
      });
    }
  };

  function rawForecast(sgvs, sbx) {
    var rawSGVs;

    if (sbx.properties.rawbg && sbx.extendedSettings.useRaw) {

      //TODO:OnlyOneCal - currently we only load the last cal, so we can't ignore future data
      var cal = _.last(sbx.data.cals);
      if (cal) {
        rawSGVs = _.map(_.takeRight(sgvs, 2), function eachSGV(sgv) {
          var rawResult = rawbg.calc(sgv, cal);

          //ignore when raw is 0, and use BG_MIN if raw is lower
          var rawY = rawResult === 0 ? 0 : Math.max(rawResult, BG_MIN);

          return { mills: sgv.mills, y: rawY };
        });
      }
    }

    return ar2.forecast(rawSGVs);
  }

  ar2.forecast = function forecast(sgvs) {

    var result = {
      predicted: []
      , avgLoss: 0
    };

    var lastIndex = sgvs ? sgvs.length - 1 : 0;

    if (lastIndex < 1) {
      return result;
    }

    var current = sgvs[lastIndex].y;
    var prev = sgvs[lastIndex - 1].y;

    if (current >= BG_MIN && sgvs[lastIndex - 1].y >= BG_MIN) {
      // predict using AR model
      var lastValidReadingTime = sgvs[lastIndex].mills;
      var elapsedMins = (sgvs[lastIndex].mills - sgvs[lastIndex - 1].mills) / ONE_MINUTE;
      var y = Math.log(current / BG_REF);
      if (elapsedMins < 5.1) {
        y = [Math.log(prev / BG_REF), y];
      } else {
        y = [y, y];
      }
      var n = Math.ceil(12 * (1 / 2 + (Date.now() - lastValidReadingTime) / ONE_HOUR));
      var AR = [-0.723, 1.716];
      var dt = sgvs[lastIndex].mills;
      for (var i = 0; i <= n; i++) {
        y = [y[1], AR[0] * y[0] + AR[1] * y[1]];
        dt = dt + FIVE_MINUTES;
        result.predicted[i] = {
          mills: dt,
          y: Math.max(BG_MIN, Math.min(BG_MAX, Math.round(BG_REF * Math.exp(y[1]))))
        };
      }

      // compute current loss
      var size = Math.min(result.predicted.length - 1, 6);
      for (var j = 0; j <= size; j++) {
        result.avgLoss += 1 / size * Math.pow(log10(result.predicted[j].y / 120), 2);
      }
    }

    return result;
  };

  ar2.updateVisualisation = function updateVisualisation(sbx) {
    sbx.pluginBase.addForecastPoints(ar2.forecastCone(sbx));
  };

  ar2.forecastCone = function forecastCone (sbx) {

    var sgvs = sbx.data.sgvs;

    if (sgvs.length < 2) {
      return [];
    }

    var coneFactor = getConeFactor(sbx);

    //TODO: move this to css
    var predictedColor = 'blue';
    if (sbx.defaults.theme === 'colors') {
      predictedColor = 'cyan';
    }

    function pushConePoints(result, cone) {
      var updated = {
        forecastTime: result.forecastTime + FIVE_MINUTES
        , conePoints: result.conePoints
        , prev: result.curr
        , curr: AR_CONE[0] * result.prev + AR_CONE[1] * result.curr
      };

      //offset from points so they are at a unique time
      function point(offset, cf) {
        var c = result.curr + cf * cone;
        var scaled = sbx.scaleBg(BG_REF * Math.exp(c));

        return {
          mills: updated.forecastTime + offset
          , sgv: Math.max(BG_MIN, Math.min(BG_MAX, scaled))
          , color: predictedColor
        };
      }

      if (coneFactor > 0) {
        updated.conePoints.push(point(2000, -coneFactor));
      }
      updated.conePoints.push(point(4000, coneFactor));

      return updated;
    }

    //fold left over cone periods, each time update the accumulator
    var result = _.reduce(
      [0.020, 0.041, 0.061, 0.081, 0.099, 0.116, 0.132, 0.146, 0.159, 0.171, 0.182, 0.192, 0.201]
      , pushConePoints
      , initConeAccumulator(sgvs, sbx)
    );

    return result.conePoints;
  };

  return ar2();
}

function checkForecast(forecast, sbx, usingRaw) {
  var result = undefined;

  if (forecast && forecast.avgLoss > URGENT_THRESHOLD && !usingRaw) {
    result = { level: 2 };
  } else if (forecast && forecast.avgLoss > WARN_THRESHOLD) {
    result = { level: 1 };
  }

  if (result) {
    result.forecast = forecast;
    result.usingRaw = usingRaw;
    result.eventName = selectEventType(result, sbx);
  }

  return result;
}

function selectEventType (prop, sbx) {
  var predicted = prop.forecast && _.map(prop.forecast.predicted, function(p) { return sbx.scaleBg(p.y) } );

  var in20mins = predicted && predicted.length >= 4 ? sbx.scaleBg(predicted[3]) : undefined;

  //if not set to high or low the default eventType will be assumed
  var eventName = '';

  if (in20mins !== undefined) {
    if (in20mins > sbx.scaleBg(sbx.thresholds.bg_target_top)) {
      eventName = 'high';
    } else if (in20mins < sbx.scaleBg(sbx.thresholds.bg_target_bottom)) {
      eventName = 'low';
    }
  }

  return eventName;
}

function buildTitle(prop, sbx) {
  var rangeLabel = prop.eventName ? prop.eventName.toUpperCase() : 'Check BG';
  var title = sbx.notifications.levels.toString(prop.level) + ', ' + rangeLabel;

  var sgv = sbx.lastScaledSGV();
  if (sgv > sbx.thresholds.bg_target_bottom && sgv < sbx.thresholds.bg_target_top) {
    title += ' predicted';
  }
  if (prop.usingRaw) {
    title += ' w/raw';
  }
  return title;
}

function pushoverSound (prop, sbx) {
  var sound;

  if (prop.level === sbx.notifications.levels.URGENT) {
    sound = 'persistent';
  } else if (prop.eventName === 'low') {
    sound = 'falling';
  } else if (prop.eventName === 'high') {
    sound = 'climb';
  }

  return sound;
}

function getConeFactor (sbx) {
  var value = Number(sbx.extendedSettings.coneFactor);
  if (isNaN(value) || value < 0) {
    value = 2;
  }
  return value;
}

function initConeAccumulator (sgvs, sbx) {
  var elapsedMins = (sgvs[sgvs.length-1].mills - sgvs[sgvs.length-2].mills) / ONE_MINUTE;

  // construct a '5m ago' sgv offset from current sgv by the average change over the lookback interval
  var delta = sgvs[sgvs.length-1].y - sgvs[sgvs.length-2].y;
  var fiveMinAgoSgv = sgvs[sgvs.length-1].y - delta / elapsedMins * 5;

  return {
    forecastTime: sbx.lastSGVMills()
    , conePoints: []
    , prev: Math.log(fiveMinAgoSgv / BG_REF)
    , curr: Math.log(sgvs[sgvs.length-1].y / BG_REF)
  };
}

function buildDebug (prop, sbx) {
  return prop.forecast && {
    usingRaw: prop.usingRaw
    , forecast: {
      avgLoss: prop.forecast.avgLoss
        , predicted: _.map(prop.forecast.predicted, function(p) { return sbx.scaleBg(p.y) }).join(', ')
    }
    , rawForecast: prop.rawForecast && {
      avgLoss: prop.rawForecast.avgLoss
      , predicted: _.map(prop.rawForecast.predicted, function(p) { return sbx.scaleBg(p.y) }).join(', ')
    }
  };
}

function log10(val) { return Math.log(val) / Math.LN10; }

module.exports = init;