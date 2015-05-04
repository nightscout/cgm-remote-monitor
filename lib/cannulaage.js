'use strict';

// class methods
function updateVisualisation() {

	var sgv = this.env.sgv;
	var age = 0;
	var found = false;
	
	for (var t in this.env.treatments)
	{
		var treatment = this.env.treatments[t];
		
		if (treatment.eventType == "Site Change")
		{
			var treatmentDate = new Date(treatment.created_at);
			var hours = Math.abs(new Date() - treatmentDate) / 36e5;
			//hours = Math.round( hours * 10 ) / 10;
			
			hours = Math.round(hours);
			
			if (!found) {
				found = true;
				age = hours;
			} else {
				if (hours < age) { age = hours; }
			}
		}
	}
	
	this.updateMajorPillText(age+'h', 'CAGE');

};


function CAGE(pluginBase) {
  pluginBase.call(this);
  
  return {
    updateVisualisation: updateVisualisation
  };
}

module.exports = CAGE;