'use strict';

var _ = require('lodash');

function init() {

  function bwp() {
    return bwp;
  }

  bwp.label = 'Bolus Wizard Preview';
  bwp.pluginType = 'pill-minor';

  bwp.updateVisualisation = function updateVisualisation (sbx) {

    var sgv = _.last(sbx.data.sgvs);
    //ug, on the client y, is unscaled, on the server we only have the unscaled sgv field
    sgv = sgv && (sgv.y || sgv.sgv);

    if (sgv == undefined || !sbx.properties.iob) return;
    
    var profile = sbx.data.profile;

    var bolusEstimate = 0.0;

    // TODO: MMOL -- Jason: if we assume sens is in display units, we don't need to do any conversion
    sgv = sbx.pluginBase.scaleBg(sgv, sbx);

    var iob = sbx.properties.iob.iob;

    var effect = iob * profile.sens;
    var outcome = sgv - effect;
    var delta = 0;

    if (outcome > profile.target_high) {
      delta = outcome - profile.target_high;
      bolusEstimate = delta / profile.sens;
    }

    if (outcome < profile.target_low) {
      delta = Math.abs(outcome - profile.target_low);
      bolusEstimate = delta / profile.sens * -1;
    }

    bolusEstimate = sbx.pluginBase.roundInsulinForDisplayFormat(bolusEstimate, sbx);
    outcome = sbx.pluginBase.roundBGToDisplayFormat(outcome, sbx);
    var displayIOB = sbx.pluginBase.roundInsulinForDisplayFormat(iob, sbx);

    // display text
    var info = [
      {label: 'Insulin on Board', value: displayIOB + 'U'}
      , {label: 'Expected effect', value: '-' + sbx.pluginBase.roundBGToDisplayFormat(effect, sbx) + ' ' + sbx.pluginBase.getBGUnits(sbx)}
      , {label: 'Expected outcome', value: outcome + ' ' + sbx.pluginBase.getBGUnits(sbx)}
    ];

    sbx.pluginBase.updatePillText(bwp, bolusEstimate + 'U', 'BWP', info);

  };

  return bwp();

}

module.exports = init;