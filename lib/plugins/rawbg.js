'use strict';

var _ = require('lodash');

function init() {

  function rawbg() {
    return rawbg;
  }

  rawbg.label = 'Raw BG';
  rawbg.pluginType = 'pill-alt';
  rawbg.pillFlip = true;

  rawbg.setProperties = function setProperties (sbx) {
    sbx.offerProperty('rawbg', function setRawBG ( ) {
      var result = { };

      var currentSGV = _.last(sbx.data.sgvs);
      var currentCal = _.last(sbx.data.cals);

      if (currentSGV && currentCal) {
        result.value = rawbg.calc(currentSGV, currentCal, sbx);
        result.noiseLabel = rawbg.noiseCodeToDisplay(currentSGV.y, currentSGV.noise);
        result.sgv = currentSGV;
        result.cal = currentCal;
      }

      return result;
    });
  };

  rawbg.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.rawbg;

    var options = prop && prop.sgv && rawbg.showRawBGs(prop.sgv.y, prop.sgv.noise, prop.cal, sbx) ? {
      hide: !prop || !prop.value
      , value: prop.value
      , label: prop.noiseLabel
    } : {
      hide: true
    };

    sbx.pluginBase.updatePillText(rawbg, options);
  };

  rawbg.calc = function calc(sgv, cal) {
    var raw = 0
      , unfiltered = parseInt(sgv.unfiltered) || 0
      , filtered = parseInt(sgv.filtered) || 0
      , sgv = sgv.y
      , scale = parseFloat(cal.scale) || 0
      , intercept = parseFloat(cal.intercept) || 0
      , slope = parseFloat(cal.slope) || 0;


    if (slope == 0 || unfiltered == 0 || scale == 0) {
      raw = 0;
    } else if (filtered == 0 || sgv < 40) {
      raw = scale * (unfiltered - intercept) / slope;
    } else {
      var ratio = scale * (filtered - intercept) / slope / sgv;
      raw = scale * ( unfiltered - intercept) / slope / ratio;
    }

    return Math.round(raw);
  };

  rawbg.isEnabled = function isEnabled(sbx) {
    return sbx.enable && sbx.enable.indexOf('rawbg') > -1;
  };

  rawbg.showRawBGs = function showRawBGs(sgv, noise, cal, sbx) {
    return cal
      && rawbg.isEnabled(sbx)
      && (sbx.defaults.showRawbg == 'always'
           || (sbx.defaults.showRawbg == 'noise' && (noise >= 2 || sgv < 40))
         );
  };

  rawbg.noiseCodeToDisplay = function noiseCodeToDisplay(sgv, noise) {
    var display;
    switch (parseInt(noise)) {
      case 0: display = '---'; break;
      case 1: display = 'Clean'; break;
      case 2: display = 'Light'; break;
      case 3: display = 'Medium'; break;
      case 4: display = 'Heavy'; break;
      default:
        if (sgv < 40) {
          display = 'Heavy';
        } else {
          display = '~~~';
        }
        break;
    }
    return display;
  };

  return rawbg();

}

module.exports = init;