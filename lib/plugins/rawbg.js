'use strict';

var _ = require('lodash');

function init() {

  var rawbg = {
    name: 'rawbg'
    , label: 'Raw BG'
    , pluginType: 'bg-status'
    , pillFlip: true
  };

  rawbg.setProperties = function setProperties (sbx) {
    sbx.offerProperty('rawbg', function setRawBG ( ) {
      var result = { };
      var currentSGV = sbx.lastSGVEntry();

      //TODO:OnlyOneCal - currently we only load the last cal, so we can't ignore future data
      var currentCal = _.last(sbx.data.cals);

      var staleAndInRetroMode = sbx.data.inRetroMode && !sbx.isCurrent(currentSGV);

      if (!staleAndInRetroMode && currentSGV && currentCal) {
        result.mgdl = rawbg.calc(currentSGV, currentCal, sbx);
        result.noiseLabel = rawbg.noiseCodeToDisplay(currentSGV.mgdl, currentSGV.noise);
        result.sgv = currentSGV;
        result.cal = currentCal;
        result.displayLine = ['Raw BG:', sbx.scaleMgdl(result.mgdl), sbx.unitsLabel, result.noiseLabel].join(' ');
      }

      return result;
    });
  };

  rawbg.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.rawbg;

    var options = prop && prop.sgv && rawbg.showRawBGs(prop.sgv.mgdl, prop.sgv.noise, prop.cal, sbx) ? {
      hide: !prop || !prop.mgdl
      , value: sbx.scaleMgdl(prop.mgdl)
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
    } else if (cleaned.filtered === 0 || sgv.mgdl < 40) {
      raw = cleaned.scale * (cleaned.unfiltered - cleaned.intercept) / cleaned.slope;
    } else {
      var ratio = cleaned.scale * (cleaned.filtered - cleaned.intercept) / cleaned.slope / sgv.mgdl;
      raw = cleaned.scale * (cleaned.unfiltered - cleaned.intercept) / cleaned.slope / ratio;
    }

    return Math.round(raw);
  };

  rawbg.isEnabled = function isEnabled(sbx) {
    return sbx.settings.isEnabled('rawbg');
  };

  rawbg.showRawBGs = function showRawBGs(mgdl, noise, cal, sbx) {
    return cal
      && rawbg.isEnabled(sbx)
      && (sbx.settings.showRawbg === 'always'
           || (sbx.settings.showRawbg === 'noise' && (noise >= 2 || mgdl < 40))
         );
  };

  rawbg.noiseCodeToDisplay = function noiseCodeToDisplay(mgdl, noise) {
    var display;
    switch (parseInt(noise)) {
      case 0: display = '---'; break;
      case 1: display = 'Clean'; break;
      case 2: display = 'Light'; break;
      case 3: display = 'Medium'; break;
      case 4: display = 'Heavy'; break;
      default:
        if (mgdl < 40) {
          display = 'Heavy';
        } else {
          display = '~~~';
        }
        break;
    }
    return display;
  };

  return rawbg;

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