'use strict';
function calcTotal(treatments, profile, time) {
var iob = 0
, activity = 0;
if (!treatments) return {};
if (profile === undefined) {
//if there is no profile default to 3 hour dia
profile = {dia: 3, sens: 0};
}
if (time === undefined) {
time = new Date();
}
treatments.forEach(function (treatment) {
if (new Date(treatment.created_at) < time) {
var tIOB = calcTreatment(treatment, profile, time);
if (tIOB && tIOB.iobContrib) iob += tIOB.iobContrib;
if (tIOB && tIOB.activityContrib) activity += tIOB.activityContrib;
}
});
return {
iob: iob,
display: iob.toFixed(2) == '-0.00' ? '0.00' : iob.toFixed(2),
activity: activity
};
}
function calcTreatment(treatment, profile, time) {
var dia = profile.dia
, scaleFactor = 3.0 / dia
, peak = 75
, sens = profile.sens
, iobContrib = 0
, activityContrib = 0;
if (treatment.insulin) {
var bolusTime = new Date(treatment.created_at);
// minAgo is the time elapsed from the initial time when insulin was administered [min]
var minAgo=(t-bolusTime)/1000/60;
// if minAgo is less than 0
if (minAgo < 0) { 
// insulin on board [U] and activity contribution [mg/dL/min] equal 0
iobContrib = 0;
activityContrib = 0;
}
// if minAgo is less than the duration of insulin action in minutes
if (minAgo < dia*60) {
// the normalized value of time
var x = (minAgo-((1/scalefactor))*90)/((1/scalefactor)*53.26);
// insulin on board [U] equals
iobContrib=treatment.insulin*((-0.1663*x*x*x*x*x*x - 0.6144*x*x*x*x*x - 0.8617*x*x*x*x + 6.638*x*x*x + 6.04*x*x -42.54*x + 45.48)/100);  
// activity contribution [mg/dL/min] equals
activityContrib=sens*treatment.insulin*(2/dia/60-(minAgo-(peak*(1/scalefactor)))*2/dia/60/(60*dia-(peak*(1/scalefactor)));
}
// otherwise 
else {
// insulin on board [U] equals 0
iobContrib=0;
// activity contribution [mg/dL/min] equals 0
activityContrib=0;
}
}
return {
iobContrib: iobContrib,
activityContrib: activityContrib
};
}
function IOB(opts) {
return {
calcTotal: calcTotal
};
}
