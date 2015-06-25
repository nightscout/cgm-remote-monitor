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
      return delta.calc(
        sbx.data.sgvs.length >= 2 ? sbx.data.sgvs[sbx.data.sgvs.length - 2].y : null
        , sbx.data.sgvs.length >= 1 ? sbx.data.sgvs[sbx.data.sgvs.length - 1].y : null
        , sbx
      );
    });
  };

  delta.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.delta;
    sbx.pluginBase.updatePillText(delta, {
      value: prop.display
      , label: sbx.unitsLabel
    });
  };

  delta.calc = function calc(prevSVG, currentSGV, sbx) {
    var result = { display: null };

    if (!prevSVG || !currentSGV) { return result; }

    if (currentSGV < 40 || prevSVG < 40) { return result; }
    if (currentSGV > 400 || prevSVG > 400) { return result; }

    result.value = sbx.roundBGToDisplayFormat(sbx.scaleBg(currentSGV) - sbx.scaleBg(prevSVG));
    result.display = (result.value >= 0 ? '+' : '') + result.value;

    return result;
  };

  return delta();

}

module.exports = init;