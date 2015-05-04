'use strict';

function getData()
{
	return this.cobTotal(this.env.treatments,this.env.time);	
}

function cobTotal(treatments, time) {
	var liverSensRatio = 1;
	var sens = this.profile.sens;
	var carbratio = this.profile.carbratio;
	var cob=0;
	if (!treatments) return {};
	if (typeof time === 'undefined') {
		var time = new Date();
	}

	var isDecaying = 0;
	var lastDecayedBy = new Date('1/1/1970');
	var carbs_hr = this.profile.carbs_hr;

	for (var t in treatments)
	{
		var treatment = treatments[t];
		if(treatment.carbs && treatment.created_at < time) {
			var cCalc = this.cobCalc(treatment, lastDecayedBy, time);
			var decaysin_hr = (cCalc.decayedBy-time)/1000/60/60;
			if (decaysin_hr > -10) {
				var actStart = this.iobTotal(treatments, lastDecayedBy).activity;
				var actEnd = this.iobTotal(treatments, cCalc.decayedBy).activity;
				var avgActivity = (actStart+actEnd)/2;
				var delayedCarbs = avgActivity*liverSensRatio*sens/carbratio;
				var delayMinutes = Math.round(delayedCarbs/carbs_hr*60);
				if (delayMinutes > 0) {
					cCalc.decayedBy.setMinutes(cCalc.decayedBy.getMinutes() + delayMinutes);
					decaysin_hr = (cCalc.decayedBy-time)/1000/60/60;
				}
			}

			if (cCalc) {
				lastDecayedBy = cCalc.decayedBy;
			}

			if (decaysin_hr > 0) {
		//console.info('Adding ' + delayMinutes + ' minutes to decay of ' + treatment.carbs + 'g bolus at ' + treatment.created_at);
				cob += Math.min(cCalc.initialCarbs, decaysin_hr * carbs_hr);
				console.log("cob: " + Math.min(cCalc.initialCarbs, decaysin_hr * carbs_hr));
				isDecaying = cCalc.isDecaying;
			}
			else {
				cob = 0;
			}

		}
	}
	var rawCarbImpact = isDecaying*sens/carbratio*carbs_hr/60;
	return {
		decayedBy: lastDecayedBy,
		isDecaying: isDecaying,
		carbs_hr: carbs_hr,
		rawCarbImpact: rawCarbImpact,
		cob: cob
	};
}

 function iobTotal(treatments, time) {
        var iob= 0;
        var activity = 0;
        if (!treatments) return {};
        if (typeof time === 'undefined') {
            var time = new Date();
        }

        for (var t in treatments) {
        	var treatment = treatments[t];
            if(treatment.created_at < time) {
                var tIOB = this.iobCalc(treatment, time);
                if (tIOB && tIOB.iobContrib) iob += tIOB.iobContrib;
                if (tIOB && tIOB.activityContrib) activity += tIOB.activityContrib;
            }
        };
        return {
            iob: iob,
            activity: activity
        };
    }


function carbImpact(rawCarbImpact, insulinImpact) {
	var liverSensRatio = 1.0;
	var liverCarbImpactMax = 0.7;
	var liverCarbImpact = Math.min(liverCarbImpactMax, liverSensRatio*insulinImpact);
	//var liverCarbImpact = liverSensRatio*insulinImpact;
	var netCarbImpact = Math.max(0, rawCarbImpact-liverCarbImpact);
	var totalImpact = netCarbImpact - insulinImpact;
	return {
		netCarbImpact: netCarbImpact,
		totalImpact: totalImpact
	}
}

function iobCalc(treatment, time) {

        var dia=this.profile.dia;
        var scaleFactor = 3.0/dia;
        var peak = 75;
        var sens=this.profile.sens;
        var iobContrib, activityContrib;
        var t = time;
        if (typeof t === 'undefined') {
            t = new Date();
        }

        if (treatment.insulin) {
            var bolusTime=new Date(treatment.created_at);
            var minAgo=scaleFactor*(t-bolusTime)/1000/60;

            if (minAgo < 0) { 
                iobContrib=0;
                activityContrib=0;
            }
            if (minAgo < peak) {
                var x = minAgo/5+1;
                iobContrib=treatment.insulin*(1-0.001852*x*x+0.001852*x);
                activityContrib=sens*treatment.insulin*(2/dia/60/peak)*minAgo;

            }
            else if (minAgo < 180) {
                var x = (minAgo-75)/5;
                iobContrib=treatment.insulin*(0.001323*x*x - .054233*x + .55556);
                activityContrib=sens*treatment.insulin*(2/dia/60-(minAgo-peak)*2/dia/60/(60*dia-peak));
            }
            else {
                iobContrib=0;
                activityContrib=0;
            }
            return {
                iobContrib: iobContrib,
                activityContrib: activityContrib
            };
        }
        else {
            return '';
        }
    }

function cobCalc(treatment, lastDecayedBy, time) {

	var carbs_hr = this.profile.carbs_hr;
	var delay = 20;
	var carbs_min = carbs_hr / 60;
	var isDecaying = 0;        
	var initialCarbs;

	if (treatment.carbs) {
		var carbTime = new Date(treatment.created_at);

		var decayedBy = new Date(carbTime);
		var minutesleft = (lastDecayedBy-carbTime)/1000/60;
		decayedBy.setMinutes(decayedBy.getMinutes() + Math.max(delay,minutesleft) + treatment.carbs/carbs_min); 
		if(delay > minutesleft) { 
			initialCarbs = parseInt(treatment.carbs); 
		}
		else { 
			initialCarbs = parseInt(treatment.carbs) + minutesleft*carbs_min; 
		}
		var startDecay = new Date(carbTime);
		startDecay.setMinutes(carbTime.getMinutes() + delay);
		if (time < lastDecayedBy || time > startDecay) {
			isDecaying = 1;
		}
		else {
			isDecaying = 0;
		}
		return {
			initialCarbs: initialCarbs,
			decayedBy: decayedBy,
			isDecaying: isDecaying,
			carbTime: carbTime
		};
	}
	else {
		return '';
	}
}

function updateVisualisation() {
		
	var displayCob = Math.round(this.env.cob.cob * 10) / 10;
			
	this.updateMajorPillText(displayCob + " g",'COB');
	
}


function COB(pluginBase) {

  if (pluginBase) { pluginBase.call(this); }
  
  return {
  	cobTotal: cobTotal,
  	cobCalc: cobCalc,
  	iobTotal: iobTotal,
  	iobCalc: iobCalc,
    getData: getData,
    updateVisualisation: updateVisualisation
  };

}

module.exports = COB;
