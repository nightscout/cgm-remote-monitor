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
        sbx.data.sgvs.length >= 2 ? sbx.data.sgvs[sbx.data.sgvs.length - 2].mgdl : null
        , sbx.data.sgvs.length >= 1 ? sbx.data.sgvs[sbx.data.sgvs.length - 1].mgdl : null
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

  delta.calc = function calc(prevMGDL, currentMGDL, sbx) {
    var result = { display: null };

    if (!prevMGDL || !currentMGDL) { return result; }

    if (currentMGDL < 40 || prevMGDL < 40) { return result; }
    if (currentMGDL > 400 || prevMGDL > 400) { return result; }

    result.value = sbx.roundBGToDisplayFormat(sbx.scaleBg(currentMGDL) - sbx.scaleBg(prevMGDL));
    result.display = (result.value >= 0 ? '+' : '') + result.value;

    return result;
  };

  return delta();

}

module.exports = init;