'use strict';

var _ = require('lodash');
var levels = require('../levels');
var times = require('../times');
var rawbg = require('./rawbg')();
var delta = require('./delta')();

var BG_REF = 140; //Central tendency
var BG_MIN = 36; //Not 39, but why?
var BG_MAX = 400;
var WARN_THRESHOLD = 0.05;
var URGENT_THRESHOLD = 0.10;

var AR = [-0.723, 1.716];

//TODO: move this to css
var AR2_COLOR = 'cyan';

function init() {

  var ar2 = {
    name: 'ar2'
    , label: 'AR2'
    , pluginType: 'forecast'
  };

  ar2.setProperties = function setProperties (sbx) {
    sbx.offerProperty('ar2', function setAR2 ( ) {

      var prop = {
        forecast: ar2.forecast(sbx.lastNEntries(sbx.data.sgvs, 2), sbx)
        , rawForecast: rawForecast(sbx)
      };

      var result = checkForecast(prop.forecast, sbx) || checkForecast(prop.rawForecast, sbx, true);

      if (result) {
        prop.level = result.level;
        prop.eventName = result.eventName;
      }

      prop.usingRaw = result && result.usingRaw || false;

      var predicted = prop.usingRaw ? prop.rawForecast && prop.rawForecast.predicted : prop.forecast && prop.forecast.predicted;
      var scaled = predicted && _.map(predicted, function(p) { return sbx.scaleEntry(p) } );

      if (scaled && scaled.length >= 3) {
        prop.displayLine = (prop.usingRaw ? 'Raw BG' : 'BG') + ' 15m: ' + scaled[2] + ' ' + sbx.unitsLabel;
      }


      return prop;
    });
  };

  ar2.checkNotifications = function checkNotifications (sbx) {
    if (Date.now() - sbx.lastSGVMills() > times.mins(10).msecs) {
      return;
    }

    var prop = sbx.properties.ar2;

    if (prop) {
      sbx.notifications.requestNotify({
        level: prop.level
        , title: buildTitle(prop, sbx)
        , message: sbx.buildDefaultMessage()
        , eventName: prop.eventName
        , pushoverSound: pushoverSound(prop)
        , plugin: ar2
        , debug: buildDebug(prop, sbx)
      });
    }
  };

  function rawForecast (sbx) {
    var rawSGVs;

    if (useRaw(sbx)) {
      //TODO:OnlyOneCal - currently we only load the last cal, so we can't ignore future data
      var cal = _.last(sbx.data.cals);
      if (cal) {
        rawSGVs = _.map(sbx.lastNEntries(sbx.data.sgvs, 2), function eachSGV(sgv) {
          var rawResult = rawbg.calc(sgv, cal);

          //ignore when raw is 0, and use BG_MIN if raw is lower
          var rawY = rawResult === 0 ? 0 : Math.max(rawResult, BG_MIN);

          return { mills: sgv.mills, mgdl: rawY };
        });
      }
    }

    return ar2.forecast(rawSGVs, sbx);
  }

  function useRaw (sbx) {
    return sbx.properties.rawbg && sbx.extendedSettings.useRaw !== undefined && (sbx.extendedSettings.useRaw === true || sbx.extendedSettings.useRaw.toLowerCase() === 'true');
  }

  ar2.forecast = function forecast (sgvs, sbx) {

    var result = {
      predicted: []
      , avgLoss: 0
    };

    if (!okToForecast(sgvs)) {
      return result;
    }

    //fold left, each time update the accumulator
    result.predicted = _.reduce(
      new Array(6) //only 6 points are used for calculating avgLoss
      , pushPoint
      , initAR2(sgvs, sbx)
    ).points;

    // compute current loss
    var size = Math.min(result.predicted.length - 1, 6);
    for (var j = 0; j <= size; j++) {
      result.avgLoss += 1 / size * Math.pow(log10(result.predicted[j].mgdl / 120), 2);
    }

    return result;
  };

  ar2.updateVisualisation = function updateVisualisation(sbx) {
    sbx.pluginBase.addForecastPoints(ar2.forecastCone(sbx));
  };

  ar2.forecastCone = function forecastCone (sbx) {

    var sgvs = sbx.lastNEntries(sbx.data.sgvs, 2);

    if (!okToForecast(sgvs)) {
      return [];
    }

    var current = sgvs[sgvs.length - 1];
    var prev = sgvs[sgvs.length - 2];

    if (!current || current.mgdl < BG_MIN || !prev || prev.mgdl < BG_MIN) {
      return [];
    }

    var coneFactor = getConeFactor(sbx);

    function pushConePoints(result, step) {
      var next = incrementAR2(result);

      //offset from points so they are at a unique time
      if (coneFactor > 0) {
        next.points.push(ar2Point(next
          , { offset: 2000, coneFactor: -coneFactor, step: step }
        ));
      }

      next.points.push(ar2Point(next
        , { offset: 4000, coneFactor: coneFactor, step: step }
      ));

      return next;
    }

    //fold left over cone steps, each time update the accumulator
    var result = _.reduce(
      [0.020, 0.041, 0.061, 0.081, 0.099, 0.116, 0.132, 0.146, 0.159, 0.171, 0.182, 0.192, 0.201]
      , pushConePoints
      , initAR2(sgvs, sbx)
    );

    return result.points;
  };

  return ar2;
}

function checkForecast(forecast, sbx, usingRaw) {
  var result = undefined;

  if (forecast && forecast.avgLoss > URGENT_THRESHOLD && usingRaw) {
    //only send warnings for raw, and only when urgent is predicted
    result = { level: levels.WARN };
  } else {
    if (forecast && forecast.avgLoss > URGENT_THRESHOLD) {
      result = { level: levels.URGENT };
    } else if (forecast && forecast.avgLoss > WARN_THRESHOLD) {
      result = { level: levels.WARN };
    }
  }

  if (result) {
    result.forecast = forecast;
    result.usingRaw = usingRaw;
    result.eventName = selectEventType(result, sbx);
  }

  return result;
}

function selectEventType (prop, sbx) {
  var predicted = prop.forecast && _.map(prop.forecast.predicted, function(p) { return sbx.scaleEntry(p) } );

  var in20mins = predicted && predicted.length >= 4 ? predicted[3] : undefined;

  //if not set to high or low the default eventType will be assumed
  var eventName = '';

  if (in20mins !== undefined) {
    if (in20mins > sbx.scaleMgdl(sbx.settings.thresholds.bgTargetTop)) {
      eventName = 'high';
    } else if (in20mins < sbx.scaleMgdl(sbx.settings.thresholds.bgTargetBottom)) {
      eventName = 'low';
    }
  }

  return eventName;
}

function buildTitle(prop, sbx) {
  var rangeLabel = prop.eventName ? prop.eventName.toUpperCase() : 'Check BG';
  var title = levels.toDisplay(prop.level) + ', ' + rangeLabel;

  var sgv = sbx.lastScaledSGV();
  if (sgv > sbx.scaleMgdl(sbx.settings.thresholds.bgTargetBottom) && sgv < sbx.scaleMgdl(sbx.settings.thresholds.bgTargetTop)) {
    title += ' predicted';
  }
  if (prop.usingRaw) {
    title += ' w/raw';
  }
  return title;
}

function pushoverSound (prop) {
  var sound;

  if (prop.level === levels.URGENT) {
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

function okToForecast(sgvs) {
  if (!sgvs || sgvs.length < 2) {
    return false;
  }

  var current = sgvs[sgvs.length - 1];
  var prev = sgvs[sgvs.length - 2];

  return current && current.mgdl >= BG_MIN && prev && prev.mgdl >= BG_MIN;
}

function initAR2 (sgvs, sbx) {
  var current = sgvs[sgvs.length - 1];
  var prev = sgvs[sgvs.length - 2];
  var mgdl5MinsAgo = delta.calc(prev, current, sbx).mgdl5MinsAgo;

  return {
    forecastTime: current.mills || Date.now()
    , points: []
    , prev: Math.log(mgdl5MinsAgo / BG_REF)
    , curr: Math.log(current.mgdl / BG_REF)
  };
}

function incrementAR2 (result) {
  return {
    forecastTime: result.forecastTime + times.mins(5).msecs
    , points: result.points || []
    , prev: result.curr
    , curr: AR[0] * result.prev + AR[1] * result.curr
  };
}

function pushPoint(result) {
  var next = incrementAR2(result);

  next.points.push(ar2Point(
    next
    , { offset: 2000 }
  ));

  return next;
}


function ar2Point(next, options) {
  var step = options.step || 0;
  var coneFactor = options.coneFactor || 0;
  var offset = options.offset || 0;

  var mgdl = Math.round(BG_REF * Math.exp(
    next.curr + coneFactor * step
  ));

  return {
    mills: next.forecastTime + offset
    , mgdl: Math.max(BG_MIN, Math.min(BG_MAX, mgdl))
    , color: AR2_COLOR
  };
}


function buildDebug (prop, sbx) {
  return prop.forecast && {
    usingRaw: prop.usingRaw
    , forecast: {
      avgLoss: prop.forecast.avgLoss
        , predicted: _.map(prop.forecast.predicted, function(p) { return sbx.scaleEntry(p) }).join(', ')
    }
    , rawForecast: prop.rawForecast && {
      avgLoss: prop.rawForecast.avgLoss
      , predicted: _.map(prop.rawForecast.predicted, function(p) { return sbx.scaleEntry(p) }).join(', ')
    }
  };
}

function log10(val) { return Math.log(val) / Math.LN10; }

module.exports = init;