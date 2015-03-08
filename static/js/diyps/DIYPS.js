function DIYPS(treatments, recentBGs, time, recentLookback, profile) {

    var tick = 5;
    var predict_hr = 3;

    var cTotal = cobTotal(treatments, time);
    var cob = cTotal.cob;
    var carbImpact = cTotal.carbImpact;
    var isDecaying = cTotal.isDecaying;
    var nextCarbTreatment = cTotal.nextCarbTreatment;

    var sgv=parseInt(recentBGs[recentBGs.length].sgv);
    var bgi = sgv;
    var initBg = {}, predBgs = [];
    initBg.bg = sgv;
    initBg.time = time;
    predBgs.push(initBg);

    var endtime=new Date(time);
    endtime.setHours(endtime.getHours() + predict_hr);

    var t = new Date(time.getTime());
    // every 5 minutes:
    for (t.setMinutes(t.getMinutes() + tick); t < endtime; t.setMinutes(t.getMinutes() + tick)) {
        // re-run iobTotal() to get latest insulinActivity
        var iTotal = iobTotal(treatments, time);
        var insulinImpact = iTotal.activity;
        if (cob > 0 && isDecaying) {
            // calculate carbImpact and change in cob as a function of insulinActivity
            carbImpact=0;
            carbImpact = tick*(carbs_hr/60 - Math.min(0,insulinActivity*sens);
            cobDecay = carbImpact/carbRatio;
            cob = cob - cobDecay;
        else {
            // if there is a new carb treatment after cob=0, or we're in the 20m delay, recalculate everything
            if (t > nextCarbTreatment || cob > 0) {
                cTotal = cobTotal(treatments, t);
                cob = cTotal.cob;
                carbImpact = cTotal.carbImpact;
                isDecaying = cTotal.isDecaying;
                nextCarbTreatment = cTotal.nextCarbTreatment;
            }
            // otherwise, no need to do anything until the nextCarbTreatment
            else {
                carbimpact = 0;
                cob = 0;
            }
        }
        var totalImpact = carbImpact-insulinImpact;

        // use totalImpact to calculate predBG[]
        bgi = bgi + totalImpact;
        var time = new Date(t.getTime());
        var predBg = {};
        predBg.bg = bgi;
        predBg.time = time;
        predBgs.push(predBg);

        // use predictAR as well, either here or in the calling function

    }
        
	var iTotal = iobTotal(treatments, time);
	var iob = iTotal.iob;
	var insulinActivity = iTotal.activity;

    var cTotal = cobTotal(treatments, time);
    var cob = cTotal.cob;
    var carbImpact = cTotal.carbImpact;
    var decayedBy = cTotal.decayedBy;

    var totalActivity = carbImpact-insulinActivity;


	return {
		predBGs: predBGs,
		cob: cob,
		iob: iob
		insulinActivity: insulinActivity,
		carbImpact: carbImpact,
		totalActivity: totalActivity
		decayedBy: decayedBy,
		//recentCarbs: recentCarbs,
		//recentInsulin: recentInsulin
	};
}

function iobTotal(treatments, time) {
    var iob= 0;
    var activity = 0;
    if (!treatments) return {};

    treatments.forEach(function(treatment) {
        if(treatment.created_at < time) {
            var iCalc = iobCalc(treatment, time);
            if (iCalc && iCalc.iobContrib) iob += iCalc.iobContrib;
            if (iCalc && iCalc.activityContrib) activity += iCalc.activityContrib;
        }
    });
    return {
        iob: iob,
        activity: activity
    };
}

function iobCalc(treatment, time) {

    var dia=profile.dia;
    if (dia == 3) {
        var peak=75;
    } else {
        console.warn('DIA of ' + dia + 'not supported');
    }
    var sens=profile.sens;
    if (typeof time === 'undefined') {
        var time = new Date();
    }

    if (treatment.insulin) {
        var bolusTime=new Date(treatment.created_at);
        var minAgo=(time-bolusTime)/1000/60;

        if (minAgo < 0) { 
            var iobContrib=0;
            var activityContrib=0;
        }
        if (minAgo < peak) {
            var x = minAgo/5+1;
            var iobContrib=treatment.insulin*(1-0.001852*x*x+0.001852*x);
            var activityContrib=sens*treatment.insulin*(2/dia/60/peak)*minAgo;

        }
        else if (minAgo < 180) {
            var x = (minAgo-75)/5;
            var iobContrib=treatment.insulin*(0.001323*x*x - .054233*x + .55556);
            var activityContrib=sens*treatment.insulin*(2/dia/60-(minAgo-peak)*2/dia/60/(60*dia-peak));
        }
        else {
            var iobContrib=0;
            var activityContrib=0;
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

// TODO: replace this with the latest version that takes insulinActivity into account
// TODO: make sure the new version returns actual COB, not based on decayedBy after adjusting for insulinActivity
function cobTotal(treatments, time) {
	var cob=0;
	if (!treatments) return {};
	if (typeof time === 'undefined') {
	    var time = new Date();
	}

	var isDecaying = 1;
	var lastDecayedBy = new Date("1/1/1970");
	var carbs_hr = profile.carbs_hr;

	treatments.forEach(function(treatment) {
	    if(treatment.carbs) {
            if (treatment.date < time) {
                var cCalc = cobCalc(treatment, lastDecayedBy, time);
                if (cCalc) {
                    lastDecayedBy = cCalc.decayedBy;
                    if (cCalc.carbsleft) {
                    var carbsleft = + cCalc.carbsleft;
                    }
                }

                var decaysin_hr = (lastDecayedBy-time)/1000/60/60;
                if (decaysin_hr > 0) {
                    cob = Math.min(cCalc.initialCarbs, decaysin_hr * carbs_hr);
                    isDecaying = cCalc.isDecaying;
                }
                else {
                    cob = 0;
                }
            }
            else {
                var nextCarbTreatment = new Date(treatment.date);
                break;
            }
	    }
	});
	var sens = profile.sens;
	var carbratio = profile.carbratio;
	var carbImpact = isDecaying*sens/carbratio*carbs_hr/60;
	return {
	    decayedBy: lastDecayedBy,
	    isDecaying: isDecaying,
        nextCarbTreatment: nextCarbTreatment,
	    carbs_hr: carbs_hr,
	    carbImpact: carbImpact,
	    cob: cob
	};
}

function cobCalc(treatment, lastDecayedBy, time) {

    var carbs_hr = profile.carbs_hr;
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
            initialCarbs = treatment.carbs; 
        }
        else { 
            initialCarbs = treatment.carbs + minutesleft*carbs_min; 
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
