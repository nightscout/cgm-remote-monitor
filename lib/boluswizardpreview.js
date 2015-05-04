'use strict';

// class methods
function updateVisualisation() {

	var sgv = this.env.sgv;
	
	var bat = 0.0;
	
	// TODO: MMOL 
	sgv = Number(sgv)/18;
	
	// Above target -> calculate insulin dose against target_high
	
	if (sgv > this.profile.target_high)
	{
		var delta = sgv - this.profile.target_high;
		bat = (delta / this.profile.sens) - this.iob.iob;
	}

	// between targets
	
	if (sgv >= this.profile.target_low && sgv <= this.profile.target_high && this.iob.iob > 0)
	{
		// ...
	}

	// Above target -> calculate insulin dose against target_low

	if (sgv < this.profile.target_low)
	{
		var delta = this.profile.target_low - sgv;
		bat = 0-(delta / this.profile.sens) - this.iob.iob;
	}
	
	bat = Math.round(bat * 100) / 100;

	// display text
		
	this.updateMajorPillText(bat + 'U','BWP');

};


function BWP(pluginBase) {
  pluginBase.call(this);
  
  return {
    updateVisualisation: updateVisualisation,
    isDataProvider: false,
    isVisualisationProvider: true

  };
}

module.exports = BWP;