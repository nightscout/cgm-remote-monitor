'use strict';

function init() {

  function delta() {
    return delta;
  }

  delta.label = 'BG Delta';
  delta.pluginType = 'pill-major';
  delta.pillFlip = true;

  delta.setProperties = function setProperties (sbx) {
    sbx.offerProperty('delta', function setDelta ( ) {

      var result = { display: null };

      if (sbx.data.sgvs.length < 2) { return result; }

      var lastSVG = sbx.data.sgvs[sbx.data.sgvs.length - 1].y;
      var prevSVG = sbx.data.sgvs[sbx.data.sgvs.length - 2].y;

      if (lastSVG < 40 || prevSVG < 40) { return result; }

      result.value = sbx.scaleBg(lastSVG) - sbx.scaleBg(prevSVG);
      result.display = (result.value >= 0 ? '+' : '') + result.value;

      return result;
    });
  };

  delta.updateVisualisation = function updateVisualisation (sbx) {
    var info = null;
    var prop = sbx.properties.delta;
    sbx.pluginBase.updatePillText(delta, prop.display, sbx.unitsLabel, info);
  };

  return delta();

}

module.exports = init;