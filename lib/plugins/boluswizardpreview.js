'use strict';

var nsutils = require('../nsutils')();

function init() {

  function bwp() {
    return bwp;
  }

  bwp.label = 'Bolus Wizard Preview';

  bwp.updateVisualisation = function updateVisualisation() {

    var sgv = this.env.sgv;

    var bat = 0.0;

    // TODO: MMOL -- Jason: if we assume sens is in display units, we don't need to do any conversion
    sgv = this.scaleBg(sgv);

    var effect = this.iob.iob * this.profile.sens;
    var outcome = sgv - effect;
    var delta = 0;
    var info = null;

    if (outcome > this.profile.target_high) {
      delta = outcome - this.profile.target_high;
      bat = delta / this.profile.sens;
    }

    if (outcome < this.profile.target_low) {
      delta = Math.abs(outcome - this.profile.target_low);
      bat = delta / this.profile.sens * -1;
    }

    bat = nsutils.toFixed((bat * 100) / 100);
	outcome = this.roundBGToDisplayFormat(outcome);
	var displayIOB = this.roundInsulinForDisplayFormat(this.iob.iob);

    // display text
    var info = [{label: 'Insulin on Board', value: displayIOB}, {label: 'Expected effect', value: '-' + this.roundBGToDisplayFormat(effect) + ' ' + this.getBGUnits()}, {label: 'Expected outcome', value: outcome + ' ' + this.getBGUnits()}];
    this.updatePillText(bat + 'U', 'BWP', info);

  };

  return bwp();

}

module.exports = init;