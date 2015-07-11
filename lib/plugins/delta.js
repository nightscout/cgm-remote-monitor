'use strict';

var ONE_MINUTE = 60000;

function init() {

  function delta() {
    return delta;
  }

  delta.label = 'BG Delta';
  delta.pluginType = 'pill-major';
  delta.pillFlip = true;

  delta.setProperties = function setProperties (sbx) {
    sbx.offerProperty('delta', function setDelta ( ) {
      return delta.calc(
        sbx.data.sgvs.length >= 2 ? sbx.data.sgvs[sbx.data.sgvs.length - 2] : null
        , sbx.data.sgvs.length >= 1 ? sbx.data.sgvs[sbx.data.sgvs.length - 1] : null
        , sbx
      );
    });
  };

  delta.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.delta;

    var info = [];
    var display = prop.display;

    if (prop.interpolated) {
      display += ' *';
      info.push({label: 'Elapsed Time', value: Math.round(prop.elapsedMins) + ' mins'});
      info.push({label: 'Absolute Delta', value: sbx.roundBGToDisplayFormat(sbx.scaleMgdl(prop.absMgdl)) + ' ' + sbx.unitsLabel});
      info.push({label: 'Interpolated', value: sbx.roundBGToDisplayFormat(sbx.scaleMgdl(prop.mgdl5MinsAgo)) + ' ' + sbx.unitsLabel});
    }

    sbx.pluginBase.updatePillText(delta, {
      value: display
      , label: sbx.unitsLabel
      , info: info
    });
  };

  delta.calc = function calc(prev, current, sbx) {
    var result = { display: null };

    if (!isSGVOk(prev) || !isSGVOk(current)) { return result; }

    result.absMgdl = current.mgdl - prev.mgdl;
    result.elapsedMins = (current.mills - prev.mills) / ONE_MINUTE;
    result.mgdl5MinsAgo = mgdl5MinsAgo(prev, current, result);
    result.interpolated = result.mgdl5MinsAgo !== prev.mgdl;
    result.mgdl = Math.round(current.mgdl - result.mgdl5MinsAgo);
    result.scaled = sbx.roundBGToDisplayFormat(sbx.scaleMgdl(result.mgdl));
    result.display = (result.scaled >= 0 ? '+' : '') + result.scaled;

    return result;
  };

  return delta();

}

function mgdl5MinsAgo (prev, current, result) {
  var mgdlAgo;
  if (result.elapsedMins > 10) {
    mgdlAgo = current.mgdl - result.absMgdl / result.elapsedMins * 5;
  } else {
    mgdlAgo = prev.mgdl;
  }
  return Math.round(mgdlAgo);
}

function isSGVOk (entry) {
  return entry && entry.mgdl >= 13;
}

module.exports = init;