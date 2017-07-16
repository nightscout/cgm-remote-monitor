'use strict';

var ONE_MINUTE = 60000;

function init() {

  var delta = {
    name: 'delta'
    , label: 'BG Delta'
    , pluginType: 'pill-major'
    , pillFlip: true
  };

  delta.setProperties = function setProperties (sbx) {
    sbx.offerProperty('delta', function setDelta ( ) {
      var prev = sbx.prevSGVEntry();
      var current = sbx.lastSGVEntry();
      if (sbx.data.inRetroMode && !sbx.isCurrent(current)) {
        return undefined;
      } else {
        return delta.calc(
          prev
          , current
          , sbx
        );
      }
    });
  };

  delta.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.delta;

    var info = [];
    var display = prop && prop.display;

    if (prop && prop.interpolated) {
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

    updateWithInterpolation(prev, current, result);

    result.mgdl = Math.round(current.mgdl - result.mgdl5MinsAgo);
    result.scaled = sbx.settings.units === 'mmol' ?
      sbx.roundBGToDisplayFormat(sbx.scaleMgdl(current.mgdl) - sbx.scaleMgdl(result.mgdl5MinsAgo)) : result.mgdl;

    result.display = (result.scaled >= 0 ? '+' : '') + result.scaled;

    return result;
  };

  return delta;

}

function updateWithInterpolation (prev, current, result) {
  result.interpolated = result.elapsedMins > 9;
  result.mgdl5MinsAgo = result.interpolated
    ? current.mgdl - result.absMgdl / result.elapsedMins * 5
    : result.mgdl5MinsAgo = prev.mgdl;
}

function isSGVOk (entry) {
  return entry && entry.mgdl >= 13;
}

module.exports = init;
