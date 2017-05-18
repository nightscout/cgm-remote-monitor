var tz = require('moment-timezone');
var calcMealCOB = require('oref0/lib/determine-basal/cob-autosens');
var basal = require('oref0/lib/profile/basal');
var getIOB = require('oref0/lib/iob');
var ISF = require('../profile/isf');

// main function categorizeBGDatums. ;) categorize to ISF, CSF, or basals.

function categorizeBGDatums(opts) {
    var treatments = opts.treatments;
    // this sorts the treatments collection in order.
    treatments.sort(function (a, b) {
        var aDate = new Date(tz(a.timestamp));
        var bDate = new Date(tz(b.timestamp));
        //console.error(aDate);
        return bDate.getTime() - aDate.getTime();
    });
    var profileData = opts.profile;
    if (typeof(opts.glucose) !== 'undefined') {
        //var glucoseData = opts.glucose;
        var glucoseData = opts.glucose.map(function prepGlucose (obj) {
            //Support the NS sgv field to avoid having to convert in a custom way
            obj.glucose = obj.glucose || obj.sgv;
            return obj;
        });
    }
    if (typeof(opts.preppedGlucose) !== 'undefined') {
        var preppedGlucoseData = opts.preppedGlucose;
    }
    //starting variable at 0
    var boluses = 0;
    var maxCarbs = 0;
    //console.error(treatments);
    if (!treatments) return {};

    //console.error(glucoseData);
    var IOBInputs = {
        profile: profileData
    ,   history: opts.pumpHistory
    };
    // TODO: verify this is safe to remove, and do so
    var COBInputs = {
        glucoseData: glucoseData
    ,   IOBInputs: IOBInputs
    ,   basalprofile: opts.basalprofile
    };
    var mealCOB = 0;
    var CSFGlucoseData = [];
    var ISFGlucoseData = [];
    var basalGlucoseData = [];

    var bucketedData = [];
    bucketedData[0] = glucoseData[0];
    j=0;
    //for loop to validate and bucket the data
    for (var i=1; i < glucoseData.length; ++i) {
        var BGTime;
        var lastBGTime;
        if (glucoseData[i].date) {
            BGTime = new Date(glucoseData[i].date);
        } else if (glucoseData[i].displayTime) {
            BGTime = new Date(glucoseData[i].displayTime.replace('T', ' '));
        } else if (glucoseData[i].dateString) {
            BGTime = new Date(glucoseData[i].dateString);
        } else { console.error("Could not determine BG time"); }
        if (glucoseData[i-1].date) {
            lastBGTime = new Date(glucoseData[i-1].date);
        } else if (glucoseData[i-1].displayTime) {
            lastBGTime = new Date(glucoseData[i-1].displayTime.replace('T', ' '));
        } else if (glucoseData[i-1].dateString) {
            lastBGTime = new Date(glucoseData[i-1].dateString);
        } else { console.error("Could not determine last BG time"); }
        if (glucoseData[i].glucose < 39 || glucoseData[i-1].glucose < 39) {
            continue;
        }
        var elapsedMinutes = (BGTime - lastBGTime)/(60*1000);
        if(Math.abs(elapsedMinutes) > 2) {
            j++;
            bucketedData[j]=glucoseData[i];
            bucketedData[j].date = BGTime.getTime();
        } else {
            // if duplicate, average the two
            bucketedData[j].glucose = (bucketedData[j].glucose + glucoseData[i].glucose)/2;
        }
    }
    //console.error(bucketedData);
    //console.error(bucketedData[bucketedData.length-1]);
    // go through the treatments and remove any that are older than the oldest glucose value
    //console.error(treatments);
    for (var i=treatments.length-1; i>0; --i) {
        var treatment = treatments[i];
        //console.error(treatment);
        if (treatment) {
            var treatmentDate = new Date(tz(treatment.timestamp));
            var treatmentTime = treatmentDate.getTime();
            var glucoseDatum = bucketedData[bucketedData.length-1];
            //console.error(glucoseDatum);
            var BGDate = new Date(glucoseDatum.date);
            var BGTime = BGDate.getTime();
            if ( treatmentTime < BGTime ) {
                treatments.splice(i,1);
            }
        }
    }
    //console.error(treatments);
    absorbing = 0;
    mealCOB = 0;
    mealCarbs = 0;
    var type="";
    // main for loop
    for (var i=bucketedData.length-5; i > 0; --i) {
        var glucoseDatum = bucketedData[i];
        //console.error(glucoseDatum);
        var BGDate = new Date(glucoseDatum.date);
        var BGTime = BGDate.getTime();
        // As we're processing each data point, go through the treatment.carbs and see if any of them are older than
        // the current BG data point.  If so, add those carbs to COB.
        var treatment = treatments[treatments.length-1];
        if (treatment) {
            var treatmentDate = new Date(tz(treatment.timestamp));
            var treatmentTime = treatmentDate.getTime();
            //console.error(treatmentDate);
            if ( treatmentTime < BGTime ) {
                if (treatment.carbs >= 1) {
                    mealCOB += parseFloat(treatment.carbs);
                    mealCarbs += parseFloat(treatment.carbs);
                }
                treatments.pop();
            }
        }

        var BG;
        var avgDelta;
        var delta;
        // TODO: re-implement interpolation to avoid issues here with gaps
        // calculate avgDelta as last 4 datapoints to better catch more rises after COB hits zero
        if (typeof(bucketedData[i].glucose) != 'undefined') {
            //console.error(bucketedData[i]);
            BG = bucketedData[i].glucose;
            if ( BG < 40 || bucketedData[i+4].glucose < 40) {
                process.stderr.write("!");
                continue;
            }
            avgDelta = (BG - bucketedData[i+4].glucose)/4;
            delta = (BG - bucketedData[i+1].glucose);
        } else { console.error("Could not find glucose data"); }

        avgDelta = avgDelta.toFixed(2);
        glucoseDatum.avgDelta = avgDelta;
        
        //sens = ISF
        var sens = ISF.isfLookup(IOBInputs.profile.isfProfile,BGDate);
        IOBInputs.clock=BGDate.toISOString();
        // use the average of the last 4 hours' basals to help convergence; 
        // this helps since the basal this hour could be different from previous, especially if with autotune they start to diverge. 
        currentBasal = basal.basalLookup(opts.basalprofile, BGDate);
        BGDate1hAgo = new Date(BGTime-1*60*60*1000);
        BGDate2hAgo = new Date(BGTime-2*60*60*1000);
        BGDate3hAgo = new Date(BGTime-3*60*60*1000);
        basal1hAgo = basal.basalLookup(opts.basalprofile, BGDate1hAgo);
        basal2hAgo = basal.basalLookup(opts.basalprofile, BGDate2hAgo);
        basal3hAgo = basal.basalLookup(opts.basalprofile, BGDate3hAgo);
        var sum = [currentBasal,basal1hAgo,basal2hAgo,basal3hAgo].reduce(function(a, b) { return a + b; });
        IOBInputs.profile.currentBasal = Math.round((sum/4)*1000)/1000;

        //console.error(currentBasal,basal1hAgo,basal2hAgo,basal3hAgo,IOBInputs.profile.currentBasal);
        // basalBGI is BGI of basal insulin activity.
        basalBGI = Math.round(( currentBasal * sens / 60 * 5 )*100)/100; // U/hr * mg/dL/U * 1 hr / 60 minutes * 5 = mg/dL/5m 
        //console.log(JSON.stringify(IOBInputs.profile));
        // call iob since calculated elsewhere
        var iob = getIOB(IOBInputs)[0];
        //console.error(JSON.stringify(iob));

        // activity times ISF times 5 minutes is BGI
        var BGI = Math.round(( -iob.activity * sens * 5 )*100)/100;
        // datum = one glucose data point (being prepped to store in output)
        glucoseDatum.BGI = BGI;
        // calculating deviation
        deviation = avgDelta-BGI;

        // rounding and storing deviation
        deviation = deviation.toFixed(2);
        glucoseDatum.deviation = deviation;



        // Then, calculate carb absorption for that 5m interval using the deviation.
        if ( mealCOB > 0 ) {
            var profile = profileData;
            ci = Math.max(deviation, profile.min_5m_carbimpact);
            absorbed = ci * profile.carb_ratio / sens;
            mealCOB = Math.max(0, mealCOB-absorbed);
        }
        // Store the COB, and use it as the starting point for the next data point.

        // If mealCOB is zero but all deviations since hitting COB=0 are positive, assign those data points to CSFGlucoseData
        // Once deviations go negative for at least one data point after COB=0, we can use the rest of the data to tune ISF or basals
        if (mealCOB > 0 || absorbing || mealCarbs > 0) {
            if (deviation > 0) {
                absorbing = 1;
            } else {
                absorbing = 0;
            }
            if ( ! absorbing && ! mealCOB ) {
                mealCarbs = 0;
            }
            // check previous "type" value, and if it wasn't csf, set a mealAbsorption start flag
            //console.error(type);
            if ( type != "csf" ) {
                glucoseDatum.mealAbsorption = "start";
                console.error(glucoseDatum.mealAbsorption,"carb absorption");
            }
            type="csf";
            glucoseDatum.mealCarbs = mealCarbs;
            //if (i == 0) { glucoseDatum.mealAbsorption = "end"; }
            CSFGlucoseData.push(glucoseDatum);
        } else {
            // check previous "type" value, and if it was csf, set a mealAbsorption end flag
            if ( type === "csf" ) {
                CSFGlucoseData[CSFGlucoseData.length-1].mealAbsorption = "end";
                console.error(CSFGlucoseData[CSFGlucoseData.length-1].mealAbsorption,"carb absorption");
            }

            // Go through the remaining time periods and divide them into periods where scheduled basal insulin activity dominates. This would be determined by calculating the BG impact of scheduled basal insulin (for example 1U/hr * 48 mg/dL/U ISF = 48 mg/dL/hr = 5 mg/dL/5m), and comparing that to BGI from bolus and net basal insulin activity.
            // When BGI is positive (insulin activity is negative), we want to use that data to tune basals
            // When BGI is smaller than about 1/4 of basalBGI, we want to use that data to tune basals
            // When BGI is negative and more than about 1/4 of basalBGI, we can use that data to tune ISF,
            // unless avgDelta is positive: then that's some sort of unexplained rise we don't want to use for ISF, so that means basals
            if (basalBGI > -4 * BGI) {
                // attempting to prevent basal from being calculated as negative; should help prevent basals from going below 0
                var minPossibleDeviation = -( basalBGI + Math.max(0,BGI) );
                //var minPossibleDeviation = -basalBGI;
                if ( deviation < minPossibleDeviation ) {
                    console.error("Adjusting deviation",deviation,"to",minPossibleDeviation.toFixed(2));
                    deviation = minPossibleDeviation;
                    deviation = deviation.toFixed(2);
                    glucoseDatum.deviation = deviation;
                }
                type="basal";
                basalGlucoseData.push(glucoseDatum);
            } else {
                if (avgDelta > 0 ) {
                    //type="unknown"
                    type="basal"
                    basalGlucoseData.push(glucoseDatum);
                } else {
                    type="ISF";
                    ISFGlucoseData.push(glucoseDatum);
                }
            }
        }
        // debug line to print out all the things
        console.error(absorbing.toString(),"mealCOB:",mealCOB.toFixed(1),"mealCarbs:",mealCarbs,"basalBGI:",basalBGI.toFixed(1),"BGI:",BGI.toFixed(1),"at",BGDate,"dev:",deviation,"avgDelta:",avgDelta,type);
    }

    return {
        CSFGlucoseData: CSFGlucoseData,
        ISFGlucoseData: ISFGlucoseData,
        basalGlucoseData: basalGlucoseData
    };
}

exports = module.exports = categorizeBGDatums;

