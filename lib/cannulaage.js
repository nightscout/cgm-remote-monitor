'use strict';

// class methods
function updateVisualisation() {

	var sgv = this.env.sgv;

	var pill = this.currentDetails.find('span.pill.cage');

	if (!pill || pill.length == 0) {
		pill = $('<span class="pill cage"><label>CAGE</label><em></em></span>');
		 this.currentDetails.append(pill);
	}
	
	var age = 0;
	var found = false;
	
	for (var t in this.env.treatments)
	{
		var treatment = this.env.treatments[t];
		
		if (treatment.eventType == "Site Change")
		{
			var treatmentDate = new Date(treatment.created_at);
			var hours = Math.abs(new Date() - treatmentDate) / 36e5;
			hours = Math.round( hours * 10 ) / 10;
			
			if (!found) {
				found = true;
				age = hours;
			} else {
				if (hours < age) { age = hours; }
			}
		}
	}
	
	pill.find('em').text(age + 'h');

};


function CAGE(pluginBase) {
  pluginBase.call(this);
  
  return {
    updateVisualisation: updateVisualisation,
    isDataProvider: false,
    isVisualisationProvider: true

  };
}

module.exports = CAGE;