'use strict';

var _ = require('lodash');
var rawbg = require('./rawbg')();

function init() {

  function ar2() {
    return ar2;
  }

  ar2.label = 'AR2';
  ar2.pluginType = 'forecast';

  var BG_REF = 140; //Central tendency
  var BG_MIN = 36; //Not 39, but why?
  var BG_MAX = 400;
  var WARN_THRESHOLD = 0.05;
  var URGENT_THRESHOLD = 0.10;

  var ONE_HOUR = 3600000;
  var ONE_MINUTE = 60000;
  var FIVE_MINUTES = 300000;
  var TEN_MINUTES =  600000;


  ar2.checkNotifications = function checkNotifications(sbx) {

    var lastSGVEntry = _.last(sbx.data.sgvs);

    var result = {};

    if (lastSGVEntry && Date.now() - lastSGVEntry.x < TEN_MINUTES) {
      result = ar2.forcastAndCheck(sbx.data.sgvs);
    }

    var usingRaw = false;
    if (!result.trigger && sbx.extendedSettings.useRaw) {
      var cal = _.last(sbx.data.cals);
      if (cal) {
        var rawSGVs = _.map(_.takeRight(sbx.data.sgvs, 2), function eachSGV (sgv) {
          return {
            x: sgv.x
            , y: Math.max(rawbg.calc(sgv, cal), BG_MIN) //stay above BG_MIN
          };
        });
        result = ar2.forcastAndCheck(rawSGVs, true);
        usingRaw = true;
      }
    }

    if (result.trigger) {

      var predicted = _.map(result.forecast.predicted, function(p) { return sbx.scaleBg(p.y) } );

      var first = _.first(predicted);
      var last = _.last(predicted);
      var avg = _.sum(predicted) / predicted.length;

      var max = _.max([first, last, avg]);
      var min = _.min([first, last, avg]);

      var rangeLabel = '';
      var eventName = '';
      if (max > sbx.scaleBg(sbx.thresholds.bg_target_top)) {
        rangeLabel = 'HIGH';
        eventName = 'high';
        if (!result.pushoverSound) { result.pushoverSound = 'climb'; }
      } else if (min < sbx.scaleBg(sbx.thresholds.bg_target_bottom)) {
        rangeLabel =  'LOW';
        eventName = 'low';
        if (!result.pushoverSound) { result.pushoverSound = 'falling'; }
      } else {
        rangeLabel = 'Check BG';
      }

      var title = sbx.notifications.levels.toString(result.level) + ', ' + rangeLabel;
      if (lastSGVEntry.y > sbx.thresholds.bg_target_bottom && lastSGVEntry.y < sbx.thresholds.bg_target_top) {
        title += ' predicted';
      }
      if (usingRaw) {
        title += ' w/raw';
      }

      var lines = ['BG Now: ' + sbx.displayBg(sbx.data.lastSGV())];

      var delta = sbx.properties.delta && sbx.properties.delta.display;
      if (delta) {
        lines[0] += ' ' + delta;
      }
      lines[0] += ' ' + sbx.unitsLabel;

      var rawbgProp = sbx.properties.rawbg;
      if (rawbgProp) {
        lines.push(['Raw BG:', sbx.scaleBg(rawbgProp.value), sbx.unitsLabel, rawbgProp.noiseLabel].join(' '));
      }

      lines.push([usingRaw ? 'Raw BG' : 'BG', '15m:', sbx.scaleBg(predicted[2]), sbx.unitsLabel].join(' '));

      var bwp = sbx.properties.bwp && sbx.properties.bwp.bolusEstimateDisplay;
      if (bwp && bwp > 0) {
        lines.push(['BWP:', bwp, 'U'].join(' '));
      }

      var iob = sbx.properties.iob && sbx.properties.iob.display;
      if (iob) {
        lines.push(['IOB:', iob, 'U'].join(' '));
      }

      var cob = sbx.properties.cob && sbx.properties.cob.display;
      if (cob) {
        lines.push(['COB:', cob, 'g'].join(' '));
      }

      var message = lines.join('\n');

      sbx.notifications.requestNotify({
        level: result.level
        , title: title
        , message: message
        , eventName: eventName
        , pushoverSound: result.pushoverSound
        , plugin: ar2
        , debug: {
          forecast: {
            predicted: _.map(result.forecast.predicted, function(p) { return sbx.scaleBg(p.y) } ).join(', ')
          }
          , thresholds: sbx.thresholds
        }
      });
    }
  };

  ar2.forcastAndCheck = function forcastAndCheck(sgvs, usingRaw) {
    var result = {
      forecast: ar2.forecast(sgvs)
    };

    if (result.forecast.avgLoss > URGENT_THRESHOLD && !usingRaw) {
      result.trigger = true;
      result.level = 2;
      result.pushoverSound = 'persistent';
    } else if (result.forecast.avgLoss > WARN_THRESHOLD) {
      result.trigger = true;
      result.level = 1;
      result.pushoverSound = 'persistent';
    }

    return result;
  };

  ar2.forecast = function forecast(sgvs) {

    var lastIndex = sgvs.length - 1;

    var result = {
      predicted: []
      , avgLoss: 0
    };

    var current = sgvs[lastIndex].y;
    var prev = sgvs[lastIndex - 1].y;

    if (lastIndex > 0 && current >= BG_MIN && sgvs[lastIndex - 1].y >= BG_MIN) {
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

function log10(val) { return Math.log(val) / Math.LN10; }

module.exports = init;