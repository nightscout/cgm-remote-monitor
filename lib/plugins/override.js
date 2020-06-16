'use strict';

function init() {
  var override = {
    name: 'override'
    , label: 'Override'
    , pluginType: 'pill-status'
  };

  override.isActive = function isActive(overrideStatus, sbx) {

    if (!overrideStatus) {
      return false;
    } else {
      var endMoment = overrideStatus.duration ? overrideStatus.moment.clone().add(overrideStatus.duration, 'seconds') : null;
      overrideStatus.endMoment = endMoment;
      return overrideStatus.active && (!endMoment || endMoment.isAfter(sbx.time));
    }

  };

  override.updateVisualisation = function updateVisualisation (sbx) {
    var lastOverride = sbx.properties.loop.lastOverride;
    var info = [ ];
    var label = '';
    var isActive = override.isActive(lastOverride, sbx);

    if (isActive) {
      if (lastOverride.currentCorrectionRange) {
        var max = lastOverride.currentCorrectionRange.maxValue;
        var min = lastOverride.currentCorrectionRange.minValue;

        if (sbx.settings.units === 'mmol') {
          max = sbx.roundBGToDisplayFormat(sbx.scaleMgdl(max));
          min = sbx.roundBGToDisplayFormat(sbx.scaleMgdl(min));
        }

        if (lastOverride.currentCorrectionRange.minValue === lastOverride.currentCorrectionRange.maxValue) {
          label += 'BG Target: ' + min;
        } else {
          label += 'BG Targets: ' + min + ':' + max;
        }
      }
      if ((lastOverride.multiplier || lastOverride.multiplier === 0) && lastOverride.multiplier !== 1) {
        var multiplier = (lastOverride.multiplier * 100).toFixed(0);
        label += ' | O: ' + multiplier + '%';
      }
    }

    var endOverrideValue = lastOverride && lastOverride.endMoment ?
      '⇥ ' + lastOverride.endMoment.format('LT') : (lastOverride ? '∞' : '');

    sbx.pluginBase.updatePillText(override, {
      value: endOverrideValue
      , label: label
      , info: info
      , hide: !isActive
    });

  };

  return override;

}


module.exports = init;
