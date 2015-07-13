'use strict';

var _ = require('lodash');

function init() {

  function rawbg() {
    return rawbg;
  }

  rawbg.label = 'Raw BG';
  rawbg.pluginType = 'bg-status';
  rawbg.pillFlip = true;

  rawbg.setProperties = function setProperties (sbx) {
    sbx.offerProperty('rawbg', function setRawBG ( ) {
      var result = { };
      var currentSGV = sbx.lastSGVEntry();

      //TODO:OnlyOneCal - currently we only load the last cal, so we can't ignore future data
      var currentCal = _.last(sbx.data.cals);

      if (currentSGV && currentCal) {
        result.value = rawbg.calc(currentSGV, currentCal, sbx);
        result.noiseLabel = rawbg.noiseCodeToDisplay(currentSGV.y, currentSGV.noise);
        result.sgv = currentSGV;
        result.cal = currentCal;
        result.displayLine = ['Raw BG:', sbx.scaleBg(result.value), sbx.unitsLabel, result.noiseLabel].join(' ');
      }

      return result;
    });
  };

  rawbg.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.rawbg;

    var options = prop && prop.sgv && rawbg.showRawBGs(prop.sgv.y, prop.sgv.noise, prop.cal, sbx) ? {
      hide: !prop || !prop.value
      , value: sbx.scaleBg(prop.value)
      , label: prop.noiseLabel
    } : {
      hide: true
    };

    sbx.pluginBase.updatePillText(rawbg, options);
  };

  rawbg.calc = function calc(sgv, cal) {
    var raw = 0;
    var cleaned = cleanValues(sgv, cal);

    if (cleaned.slope === 0 || cleaned.unfiltered === 0 || cleaned.scale === 0) {
      raw = 0;
    } else if (cleaned.filtered === 0 || sgv.y < 40) {
      raw = cleaned.scale * (cleaned.unfiltered - cleaned.intercept) / cleaned.slope;
    } else {
      var ratio = cleaned.scale * (cleaned.filtered - cleaned.intercept) / cleaned.slope / sgv.y;
      raw = cleaned.scale * (cleaned.unfiltered - cleaned.intercept) / cleaned.slope / ratio;
    }

    return Math.round(raw);
  };

  rawbg.isEnabled = function isEnabled(sbx) {
    return sbx.enable && sbx.enable.indexOf('rawbg') > -1;
  };

  rawbg.showRawBGs = function showRawBGs(sgv, noise, cal, sbx) {
    return cal
      && rawbg.isEnabled(sbx)
      && (sbx.defaults.showRawbg === 'always'
           || (sbx.defaults.showRawbg === 'noise' && (noise >= 2 || sgv < 40))
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

function cleanValues (sgv, cal) {
  return {
    unfiltered: parseInt(sgv.unfiltered) || 0
    , filtered: parseInt(sgv.filtered) || 0
    , scale: parseFloat(cal.scale) || 0
    , intercept: parseFloat(cal.intercept) || 0
    , slope: parseFloat(cal.slope) || 0
  };
}

module.exports = init;