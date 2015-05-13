'use strict';

// class methods
function updateVisualisation() {

	var sgv = this.env.sgv;
	
	var bat = 0.0;
	
	// TODO: MMOL 
		
	sgv = this.scaleBg(sgv);

	var effect = this.iob.iob * this.profile.sens;
	var outcome = sgv - effect;
	
	if (outcome > this.profile.target_high) {
		var delta = outcome - this.profile.target_high;
		bat = delta / this.profile.sens;
	}
	
	if (outcome < this.profile.target_low) {
	
		var delta = Math.abs( outcome - this.profile.target_low);
		
		bat = delta / this.profile.sens * -1;
	
	}
	
	bat = Math.round(bat * 100) / 100;

	// display text
		
	this.updateMajorPillText(bat + 'U','BWP');

};


function BWP(pluginBase) {
  pluginBase.call(this);
  
  return {
    updateVisualisation: updateVisualisation
  };
}

module.exports = BWP;