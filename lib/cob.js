'use strict';

var currentProfile ;
	
function calcTotal(treatments, time, skipnewer) {
	
  // test if running on server or client
  if (typeof currentProfile === 'undefined') {
    if (typeof Nightscout !== 'undefined') {
      currentProfile = Nightscout.currentProfile;
    } else {
      currentProfile = require('./currentProfile')();
    }
  }
  var cob=0;
  if (!treatments) return { cob:0 };
  if (typeof time === 'undefined') {
    var time = new Date();
  }
  var isDecaying = 0;
  var lastDecayedBy = new Date("1/1/1970");
  var carbs_hr = currentProfile.car(time,2); // !!!!! now use MEDIUM GI, not sure how this affect calculation
  treatments.forEach(function(treatment) {
    if (skipnewer && new Date(treatment.created_at) > time) 
		return;
    if (treatment.carbs) {
      var tCOB = calcTreatment(treatment, lastDecayedBy, time);
      if (tCOB) {
        lastDecayedBy = tCOB.decayedBy;
        if (tCOB.carbsleft) {
          var carbsleft = + tCOB.carbsleft;
        }
      }
      var decaysin_hr = (lastDecayedBy-time)/1000/60/60;
      if (decaysin_hr > 0) {
        cob = Math.min(tCOB.initialCarbs, decaysin_hr * carbs_hr);
        isDecaying = tCOB.isDecaying;
      } else { 
        cob = 0;
      }
    }
  });
  var sens = currentProfile.isf(time,'mg/dL');
  var carbratio = currentProfile.ic(time);
  var carbImpact = isDecaying*sens/carbratio*carbs_hr/60;
  return {
    decayedBy: lastDecayedBy,
    isDecaying: isDecaying,
    carbs_hr: carbs_hr,
    carbImpact: carbImpact,
    cob: cob
  };
}

function calcTreatment(treatment, lastDecayedBy, time) {
  var gi = 2; // Medium/Unknown as default
  if (treatment.boluscalc && treatment.boluscalc.gi) gi = treatment.boluscalc.gi;
  var carbs_hr = currentProfile.car(time,gi);
  var delay = currentProfile.absorptionDelay(gi);
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
    } else { 
      initialCarbs = parseInt(treatment.carbs) + minutesleft*carbs_min; 
    }
    var startDecay = new Date(carbTime);
    startDecay.setMinutes(carbTime.getMinutes() + delay);
    if (time < lastDecayedBy || time > startDecay) {
      isDecaying = 1;
    } else {
      isDecaying = 0;
    }
    return {
      initialCarbs: initialCarbs,
      decayedBy: decayedBy,
      isDecaying: isDecaying,
      carbTime: carbTime
    };
  } else {
    return '';
  }
}

function COB(opts) {

  return {
    calcTotal: calcTotal
  };

}

module.exports = COB;