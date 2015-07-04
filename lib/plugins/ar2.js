'use strict';

var _ = require('lodash');
var rawbg = require('./rawbg')();

var BG_REF = 140; //Central tendency
var BG_MIN = 36; //Not 39, but why?
var BG_MAX = 400;
var WARN_THRESHOLD = 0.05;
var URGENT_THRESHOLD = 0.10;

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
      return {
        forecast: ar2.forecast(sbx.data.sgvs)
        , rawForecast: rawForecast(sbx.data.sgvs, sbx)
      };
    });
  };

  ar2.checkNotifications = function checkNotifications(sbx) {

    if (Date.now() - sbx.lastSGVMills() > TEN_MINUTES) {
      return;
    }

    var prop = sbx.properties.ar2;
    var result = checkForecast(prop.forecast, sbx) || checkForecast(prop.rawForecast, sbx, true);

    if (result) {
      sbx.notifications.requestNotify({
        level: result.level
        , title: buildTitle(result, sbx)
        , message: sbx.buildDefaultMessage(result.usingRaw)
        , eventName: result.eventName
        , pushoverSound: result.pushoverSound
        , plugin: ar2
        , debug: result.debug
      });
    }
  };

  function rawForecast(sgvs, sbx) {
    var rawSGVs;

    if (sbx.properties.rawbg && sbx.extendedSettings.useRaw) {
      var cal = _.last(sbx.data.cals);
      if (cal) {
        rawSGVs = _.map(_.takeRight(sgvs, 2), function eachSGV(sgv) {
          var rawResult = rawbg.calc(sgv, cal);

          //ignore when raw is 0, and use BG_MIN if raw is lower
          var rawY = rawResult === 0 ? 0 : Math.max(rawResult, BG_MIN);

          return { x: sgv.x, y: rawY };
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
      var lastValidReadingTime = sgvs[lastIndex].x;
      var elapsedMins = (sgvs[lastIndex].x - sgvs[lastIndex - 1].x) / ONE_MINUTE;
      var y = Math.log(current / BG_REF);
      if (elapsedMins < 5.1) {
        y = [Math.log(prev / BG_REF), y];
      } else {
        y = [y, y];
      }
      var n = Math.ceil(12 * (1 / 2 + (Date.now() - lastValidReadingTime) / ONE_HOUR));
      var AR = [-0.723, 1.716];
      var dt = sgvs[lastIndex].x;
      for (var i = 0; i <= n; i++) {
        y = [y[1], AR[0] * y[0] + AR[1] * y[1]];
        dt = dt + FIVE_MINUTES;
        result.predicted[i] = {
          x: dt,
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

  return ar2();
}

function checkForecast(forecast, sbx, usingRaw) {
  var result = undefined;

  if (forecast && forecast.avgLoss > URGENT_THRESHOLD && !usingRaw) {
    result = {
      level: 2
      , pushoverSound: 'persistent'
    };
  } else if (forecast && forecast.avgLoss > WARN_THRESHOLD) {
    result = { level: 1 };
  }

  if (result) {
    result.forecast = forecast;
    result.usingRaw = usingRaw;
    result.debug = {
      forecast: {
        avgLoss: forecast.avgLoss
        , predicted: _.map(forecast.predicted, function(p) { return sbx.scaleBg(p.y) } )
      }
    };

    result.eventName = selectEventType(result, sbx);
    result.rangeLabel = result.eventName ? result.eventName.toUpperCase() : 'Check BG';

    if (result.eventName && !result.pushoverSound) {
      result.pushoverSound = result.eventName === 'high' ? 'climb' : 'falling';
    }
  }

  return result;
}

function selectEventType (result, sbx) {
  var predicted = _.map(result.forecast.predicted, function(p) { return sbx.scaleBg(p.y) } );

  var first = _.first(predicted);
  var last = _.last(predicted);
  var avg = _.sum(predicted) / predicted.length;

  var max = _.max([first, last, avg]);
  var min = _.min([first, last, avg]);

  var eventName = '';

  if (max > sbx.scaleBg(sbx.thresholds.bg_target_top)) {
    eventName = 'high';
  } else if (min < sbx.scaleBg(sbx.thresholds.bg_target_bottom)) {
    eventName = 'low';
  } else {
    //use base event type for now
  }

  return eventName;
}

function buildTitle(result, sbx) {
  var title = sbx.notifications.levels.toString(result.level) + ', ' + result.rangeLabel;

  var sgv = sbx.lastScaledSGV();
  if (sgv > sbx.thresholds.bg_target_bottom && sgv < sbx.thresholds.bg_target_top) {
    title += ' predicted';
  }
  if (result.usingRaw) {
    title += ' w/raw';
  }
  return title;
}

function log10(val) { return Math.log(val) / Math.LN10; }

module.exports = init;