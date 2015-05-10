'use strict';

// class methods
function updateVisualisation() {

	var age = 0;
	var found = false;
	
	for (var t in this.env.treatments)
	{
		var treatment = this.env.treatments[t];
		
		if (treatment.eventType == "Site Change")
		{
			var treatmentDate = new Date(treatment.created_at);
			var hours = Math.round(Math.abs(new Date() - treatmentDate) / 36e5);
						
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