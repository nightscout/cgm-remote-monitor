'use strict';

function init() {

  function bwp() {
    return bwp;
  }

  bwp.label = 'Bolus Wizard Preview';
  bwp.pluginType = 'minor-pill';

  bwp.updateVisualisation = function updateVisualisation() {

    var sgv = this.env.sgv;

    var bolusEstimate = 0.0;

    // TODO: MMOL -- Jason: if we assume sens is in display units, we don't need to do any conversion
    sgv = this.scaleBg(sgv);

    var effect = this.iob.iob * this.profile.sens;
    var outcome = sgv - effect;
    var delta = 0;

    if (outcome > this.profile.target_high) {
      delta = outcome - this.profile.target_high;
      bolusEstimate = delta / this.profile.sens;
    }

    if (outcome < this.profile.target_low) {
      delta = Math.abs(outcome - this.profile.target_low);
      bolusEstimate = delta / this.profile.sens * -1;
    }

    bolusEstimate = this.roundInsulinForDisplayFormat(bolusEstimate);
    outcome = this.roundBGToDisplayFormat(outcome);
    var displayIOB = this.roundInsulinForDisplayFormat(this.iob.iob);

    // display text
    var info = [
      {label: 'Insulin on Board', value: displayIOB + 'U'}
      , {label: 'Expected effect', value: '-' + this.roundBGToDisplayFormat(effect) + ' ' + this.getBGUnits()}
      , {label: 'Expected outcome', value: outcome + ' ' + this.getBGUnits()}
    ];

    this.updatePillText(bolusEstimate + 'U', 'BWP', info);

  };

  return bwp();

}

module.exports = init;