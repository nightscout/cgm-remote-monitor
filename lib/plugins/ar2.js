'use strict';

var _ = require('lodash');

function init() {

  function ar2() {
    return ar2;
  }

  ar2.label = 'AR2';
  ar2.pluginType = 'forecast';

  var WARN_THRESHOLD = 0.05;
  var URGENT_THRESHOLD = 0.10;

  var ONE_HOUR = 3600000;
  var ONE_MINUTE = 60000;
  var FIVE_MINUTES = 300000;

  ar2.checkNotifications = function checkNotifications(sbx) {
    var forecast = ar2.forecast(sbx.data.sgvs);

    var trigger = false
      , level = 0
      , levelLabel = '';

    if (forecast.avgLoss > URGENT_THRESHOLD) {
      trigger = true;
      level = 2;
      levelLabel = 'Urgent';
    } else if (forecast.avgLoss > WARN_THRESHOLD) {
      trigger = true;
      level = 1;
      levelLabel = 'Warning';
    }

    if (trigger) {
      var lastPredicted = _.last(forecast.predicted);
      var rangeLabel = '';

      if (lastPredicted > sbx.thresholds.bg_target_bottom) {
        rangeLabel = 'HIGH';
      } else if (lastPredicted < sbx.thresholds.bg_target_top) {
        rangeLabel = 'LOW';
      }

      var title = [levelLabel, rangeLabel, 'predicted'].join(' ');
      var message = [sbx.scaleBg(forecast.predicted[2].y), 'in 15mins'].join(' ');

      sbx.notifications.requestNotify({
        level: level
        , title: title
        , message: message
        , debug: {
          forecast: forecast
          , thresholds: sbx.thresholds
        }
      });
    }
  };

  ar2.forecast = function forecast(sgvs) {

    var lastIndex = sgvs.length - 1;

    var result = {
      predicted: []
      , avgLoss: 0
    };

    if (lastIndex > 1) {
      // predict using AR model
      var lastValidReadingTime = sgvs[lastIndex].x;
      var elapsedMins = (sgvs[lastIndex].x - sgvs[lastIndex - 1].x) / ONE_MINUTE;
      var BG_REF = 140;
      var BG_MIN = 36;
      var BG_MAX = 400;
      var y = Math.log(sgvs[lastIndex].y / BG_REF);
      if (elapsedMins < 5.1) {
        y = [Math.log(sgvs[lastIndex - 1].y / BG_REF), y];
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

function log10(val) { return Math.log(val) / Math.LN10; }

module.exports = init;