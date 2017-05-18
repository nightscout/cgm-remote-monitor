'use strict';

var _ = require('lodash');
var moment = window.moment;
var times = require('../times');
var d3 = (global && global.d3) || require('d3');

var autotune = {
  name: 'autotune'
  , label: 'Autotune'
  , pluginType: 'report'
};

function init() {
  return autotune;
}

module.exports = init;
autotune.html = function html(client) {
  var translate = client.translate;
  var ret =
    '<h2>' + translate('Autotune') + '</h2>'
    ;
    return ret;
};

autotune.prepareHtml = function autotunePrepareHtml(sorteddaystoshow) {
};

autotune.report = function report_autotune(datastorage,sorteddaystoshow,options) {
    var opts = {
      profile: datastorage.profiles[0] //inputs.profile
    , history: datastorage["2017-05-17"].treatments //inputs.history
    , glucose: datastorage["2017-05-17"].sgv//inputs.glucose
    , prepped_glucose: undefined// inputs.prepped_glucose
    , basalprofile: undefined//inputs.profile.basalprofile
    };

    var prepared = autotune.generate(opts);

    autotune.tune(prepared);
};

autotune.generate = function generate (inputs) {

  //console.error(inputs);
  var treatments = find_meals(inputs);

  var opts = {
    treatments: treatments
  , profile: inputs.profile
  , pumpHistory: inputs.history
  , glucose: inputs.glucose
  , prepped_glucose: inputs.prepped_glucose
  , basalprofile: inputs.profile.basalprofile
  };

  var autotune_prep_output = autotune.sum(opts);
  return autotune_prep_output;
}


autotune.arrayHasElementWithSameTimestampAndProperty = function arrayHasElementWithSameTimestampAndProperty(array,t,propname) {
    for (var j=0; j < array.length; j++) {
        var element = array[j];
        if (element.timestamp == t && element[propname] != undefined) return true;
    }
    return false;
}

autotuen.find_meals = function findMealInputs (inputs) {
    var pumpHistory = inputs.history;
    var carbHistory = inputs.carbs;
    var profile_data = inputs.profile;
    var mealInputs = [];
    var duplicates = 0;

    for (var i=0; i < carbHistory.length; i++) {
        var current = carbHistory[i];
        if (current.carbs && current.created_at) {
            var temp = {};
            temp.timestamp = current.created_at;
            temp.carbs = current.carbs;

        if (!autotune.arrayHasElementWithSameTimestampAndProperty(mealInputs,current.created_at,"carbs")) {
                mealInputs.push(temp);
            } else {
                duplicates += 1;
            }
        }
    }
    for (var i=0; i < pumpHistory.length; i++) {
        var current = pumpHistory[i];
        if (current._type == "Bolus" && current.timestamp) {
            //console.log(pumpHistory[i]);
            var temp = {};
            temp.timestamp = current.timestamp;
            temp.bolus = current.amount;

            if (!autotune.arrayHasElementWithSameTimestampAndProperty(mealInputs,current.timestamp,"bolus")) {
                mealInputs.push(temp);
            } else {
                duplicates += 1;
            }
        } else if (current._type == "BolusWizard" && current.timestamp) {
            //console.log(pumpHistory[i]);
            var temp = {};
            temp.timestamp = current.timestamp;
            temp.carbs = current.carb_input;

            // don't enter the treatment if there's another treatment with the same exact timestamp
            // to prevent duped carb entries from multiple sources
            if (!autotune.arrayHasElementWithSameTimestampAndProperty(mealInputs,current.timestamp,"carbs")) {
                mealInputs.push(temp);
            } else {
                duplicates += 1;
            }
        } else if (current.enteredBy == "xdrip") {
            var temp = {};
            temp.timestamp = current.created_at;
            temp.carbs = current.carbs;
            temp.bolus = current.insulin;
            if (!autotune.arrayHasElementWithSameTimestampAndProperty(mealInputs,current.timestamp,"carbs")) {
                mealInputs.push(temp);
            } else {
                duplicates += 1;
            }
        } else if (current.carbs > 0) {
            var temp = {};
            temp.carbs = current.carbs;
            temp.timestamp = current.created_at;
            if (!autotune.arrayHasElementWithSameTimestampAndProperty(mealInputs,current.timestamp,"carbs")) {
                mealInputs.push(temp);
            } else {
                duplicates += 1;
            }
        }
    }

    if (duplicates > 0) console.error("Removed duplicate bolus/carb entries:" + duplicates);

    return mealInputs;
}

autotune.sum = function categorizeBGDatums(opts) {
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

// does three things - tunes basals, ISF, and CSF

autotune.tune  = function tuneAllTheThings(inputs) {

    var previousAutotune = inputs.previousAutotune;
    //console.error(previousAutotune);
    var pumpProfile = inputs.pumpProfile;
    var pumpBasalProfile = pumpProfile.basalprofile;
    //console.error(pumpBasalProfile);
    var basalProfile = previousAutotune.basalprofile;
    //console.error(basalProfile);
    var isfProfile = previousAutotune.isfProfile;
    //console.error(isfProfile);
    var ISF = isfProfile.sensitivities[0].sensitivity;
    //console.error(ISF);
    var carbRatio = previousAutotune.carb_ratio;
    //console.error(carbRatio);
    var CSF = ISF / carbRatio;
    // conditional on there being a pump profile; if not then skip
    if (pumpProfile) { pumpISFProfile = pumpProfile.isfProfile; }
    if (pumpISFProfile && pumpISFProfile.sensitivities[0]) {
        pumpISF = pumpISFProfile.sensitivities[0].sensitivity;
        pumpCarbRatio = pumpProfile.carb_ratio;
        pumpCSF = pumpISF / pumpCarbRatio;
    }
    //console.error(CSF);
    var preppedGlucose = inputs.preppedGlucose;
    var CSFGlucose = preppedGlucose.CSFGlucoseData;
    //console.error(CSFGlucose[0]);
    var ISFGlucose = preppedGlucose.ISFGlucoseData;
    //console.error(ISFGlucose[0]);
    var basalGlucose = preppedGlucose.basalGlucoseData;
    //console.error(basalGlucose[0]);

    // convert the basal profile to hourly if it isn't already
    hourlyBasalProfile = [];
    hourlyPumpProfile = [];
    for (var i=0; i < 24; i++) {
        // aututuned basal profile
        for (var j=0; j < basalProfile.length; ++j) {
            if (basalProfile[j].minutes <= i * 60) {
                if (basalProfile[j].rate == 0) {
                    console.error("ERROR: bad basalProfile",basalProfile[j]);
                    return;
                }
                hourlyBasalProfile[i] = JSON.parse(JSON.stringify(basalProfile[j]));
            }
        }
        hourlyBasalProfile[i].i=i;
        hourlyBasalProfile[i].minutes=i*60;
        var zeroPadHour = ("000"+i).slice(-2);
        hourlyBasalProfile[i].start=zeroPadHour + ":00:00";
        hourlyBasalProfile[i].rate=Math.round(hourlyBasalProfile[i].rate*1000)/1000
        // pump basal profile
        if (pumpBasalProfile && pumpBasalProfile[0]) {
            for (var j=0; j < pumpBasalProfile.length; ++j) {
                //console.error(pumpBasalProfile[j]);
                if (pumpBasalProfile[j].rate == 0) {
                    console.error("ERROR: bad pumpBasalProfile",pumpBasalProfile[j]);
                    return;
                }
                if (pumpBasalProfile[j].minutes <= i * 60) {
                    hourlyPumpProfile[i] = JSON.parse(JSON.stringify(pumpBasalProfile[j]));
                }
            }
            hourlyPumpProfile[i].i=i;
            hourlyPumpProfile[i].minutes=i*60;
            hourlyPumpProfile[i].rate=Math.round(hourlyPumpProfile[i].rate*1000)/1000
        }
    }
    //console.error(hourlyPumpProfile);
    //console.error(hourlyBasalProfile);

    // look at net deviations for each hour
    for (var hour=0; hour < 24; hour++) {
        var deviations = 0;
        for (var i=0; i < basalGlucose.length; ++i) {
            //console.error(basalGlucose[i].dateString);
            splitString = basalGlucose[i].dateString.split("T");
            timeString = splitString[1];
            splitTime = timeString.split(":");
            myHour = parseInt(splitTime[0]);
            if (hour == myHour) {
                //console.error(basalGlucose[i].deviation);
                deviations += parseFloat(basalGlucose[i].deviation);
            }
        }
        deviations = Math.round( deviations * 1000 ) / 1000
        //console.error("Hour",hour.toString(),"total deviations:",deviations,"mg/dL");
        // calculate how much less or additional basal insulin would have been required to eliminate the deviations
        // only apply 20% of the needed adjustment to keep things relatively stable
        basalNeeded = 0.2 * deviations / ISF;
        basalNeeded = Math.round( basalNeeded * 1000 ) / 1000
        // if basalNeeded is positive, adjust each of the 1-3 hour prior basals by 10% of the needed adjustment
        console.error("Hour",hour,"basal adjustment needed:",basalNeeded,"U/hr");
        if (basalNeeded > 0 ) {
            for (var offset=-3; offset < 0; offset++) {
                offsetHour = hour + offset;
                if (offsetHour < 0) { offsetHour += 24; }
                //console.error(offsetHour);
                hourlyBasalProfile[offsetHour].rate += basalNeeded / 3;
                hourlyBasalProfile[offsetHour].rate=Math.round(hourlyBasalProfile[offsetHour].rate*1000)/1000
            }
        // otherwise, figure out the percentage reduction required to the 1-3 hour prior basals
        // and adjust all of them downward proportionally
        } else if (basalNeeded < 0) {
            var threeHourBasal = 0;
            for (var offset=-3; offset < 0; offset++) {
                offsetHour = hour + offset;
                if (offsetHour < 0) { offsetHour += 24; }
                threeHourBasal += hourlyBasalProfile[offsetHour].rate;
            }
            var adjustmentRatio = 1.0 + basalNeeded / threeHourBasal;
            //console.error(adjustmentRatio);
            for (var offset=-3; offset < 0; offset++) {
                offsetHour = hour + offset;
                if (offsetHour < 0) { offsetHour += 24; }
                hourlyBasalProfile[offsetHour].rate = hourlyBasalProfile[offsetHour].rate * adjustmentRatio;
                hourlyBasalProfile[offsetHour].rate=Math.round(hourlyBasalProfile[offsetHour].rate*1000)/1000
            }
        }
    }
    if (pumpBasalProfile && pumpBasalProfile[0]) {
        for (var hour=0; hour < 24; hour++) {
            //console.error(hourlyBasalProfile[hour],hourlyPumpProfile[hour].rate*1.2);
            // cap adjustments at autosens_max and autosens_min
            autotuneMax = pumpProfile.autosens_max;
            autotuneMin = pumpProfile.autosens_min;
            var maxRate = hourlyPumpProfile[hour].rate * autotuneMax;
            var minRate = hourlyPumpProfile[hour].rate * autotuneMin;
            if (hourlyBasalProfile[hour].rate > maxRate ) {
                console.error("Limiting hour",hour,"basal to",maxRate.toFixed(2),"(which is",autotuneMax,"* pump basal of",hourlyPumpProfile[hour].rate,")");
                //console.error("Limiting hour",hour,"basal to",maxRate.toFixed(2),"(which is 20% above pump basal of",hourlyPumpProfile[hour].rate,")");
                hourlyBasalProfile[hour].rate = maxRate;
            } else if (hourlyBasalProfile[hour].rate < minRate ) {
                console.error("Limiting hour",hour,"basal to",minRate.toFixed(2),"(which is",autotuneMin,"* pump basal of",hourlyPumpProfile[hour].rate,")");
                //console.error("Limiting hour",hour,"basal to",minRate.toFixed(2),"(which is 20% below pump basal of",hourlyPumpProfile[hour].rate,")");
                hourlyBasalProfile[hour].rate = minRate;
            }
            hourlyBasalProfile[hour].rate = Math.round(hourlyBasalProfile[hour].rate*1000)/1000;
        }
    }

    console.error(hourlyBasalProfile);
    basalProfile = hourlyBasalProfile;

    // calculate median deviation and bgi in data attributable to ISF
    var deviations = [];
    var BGIs = [];
    var avgDeltas = [];
    var ratios = [];
    var count = 0;
    for (var i=0; i < ISFGlucose.length; ++i) {
        deviation = parseFloat(ISFGlucose[i].deviation);
        deviations.push(deviation);
        BGI = parseFloat(ISFGlucose[i].BGI);
        BGIs.push(BGI);
        avgDelta = parseFloat(ISFGlucose[i].avgDelta);
        avgDeltas.push(avgDelta);
        ratio = 1 + deviation / BGI;
        //console.error("Deviation:",deviation,"BGI:",BGI,"avgDelta:",avgDelta,"ratio:",ratio);
        ratios.push(ratio);
        count++;
    }
    avgDeltas.sort(function(a, b){return a-b});
    BGIs.sort(function(a, b){return a-b});
    deviations.sort(function(a, b){return a-b});
    ratios.sort(function(a, b){return a-b});
    p50deviation = percentile(deviations, 0.50);
    p50BGI = percentile(BGIs, 0.50);
    p50ratios = Math.round( percentile(ratios, 0.50) * 1000)/1000;
    if (count < 5) {
        // leave ISF unchanged if fewer than 5 ISF data points
        fullNewISF = ISF;
    } else {
        // calculate what adjustments to ISF would have been necessary to bring median deviation to zero
        fullNewISF = ISF * p50ratios;
    }
    fullNewISF = Math.round( fullNewISF * 1000 ) / 1000;
    // and apply 10% of that adjustment
    var newISF = ( 0.9 * ISF ) + ( 0.1 * fullNewISF );
    if (typeof(pumpISF) !== 'undefined') {
        // low autosens ratio = high ISF
        var maxISF = pumpISF / autotuneMin;
        // high autosens ratio = low ISF
        var minISF = pumpISF / autotuneMax;
        if (newISF > maxISF) {
            console.error("Limiting ISF of",newISF.toFixed(2),"to",maxISF.toFixed(2),"(which is pump ISF of",pumpISF,"/",autotuneMin,")");
            newISF = maxISF;
        } else if (newISF < minISF) {
            console.error("Limiting ISF of",newISF.toFixed(2),"to",minISF.toFixed(2),"(which is pump ISF of",pumpISF,"/",autotuneMax,")");
            newISF = minISF;
        }
    }
    newISF = Math.round( newISF * 1000 ) / 1000;
    //console.error(avgRatio);
    //console.error(newISF);
    console.error("p50deviation:",p50deviation,"p50BGI",p50BGI,"p50ratios:",p50ratios,"Old ISF:",ISF,"fullNewISF:",fullNewISF,"newISF:",newISF);

    ISF = newISF;

    // calculate net deviations while carbs are absorbing
    // measured from carb entry until COB and deviations both drop to zero

    var deviations = 0;
    var mealCarbs = 0;
    var totalMealCarbs = 0;
    var totalDeviations = 0;
    var fullNewCSF;
    //console.error(CSFGlucose[0].mealAbsorption);
    //console.error(CSFGlucose[0]);
    for (var i=0; i < CSFGlucose.length; ++i) {
        //console.error(CSFGlucose[i].mealAbsorption, i);
        if ( CSFGlucose[i].mealAbsorption === "start" ) {
            deviations = 0;
            mealCarbs = parseInt(CSFGlucose[i].mealCarbs);
        } else if (CSFGlucose[i].mealAbsorption === "end") {
            deviations += parseFloat(CSFGlucose[i].deviation);
            // compare the sum of deviations from start to end vs. current CSF * mealCarbs
            //console.error(CSF,mealCarbs);
            csfRise = CSF * mealCarbs;
            //console.error(deviations,ISF);
            //console.error("csfRise:",csfRise,"deviations:",deviations);
            totalMealCarbs += mealCarbs;
            totalDeviations += deviations;

        } else {
            deviations += Math.max(0*previousAutotune.min_5m_carbimpact,parseFloat(CSFGlucose[i].deviation));
            mealCarbs = Math.max(mealCarbs, parseInt(CSFGlucose[i].mealCarbs));
        }
    }
    // at midnight, write down the mealcarbs as total meal carbs (to prevent special case of when only one meal and it not finishing absorbing by midnight)
    // TODO: figure out what to do with dinner carbs that don't finish absorbing by midnight
    if (totalMealCarbs == 0) { totalMealCarbs += mealCarbs; }
    if (totalDeviations == 0) { totalDeviations += deviations; }
    //console.error(totalDeviations, totalMealCarbs);
    if (totalMealCarbs == 0) {
        // if no meals today, CSF is unchanged
        fullNewCSF = CSF;
    } else {
        // how much change would be required to account for all of the deviations
        fullNewCSF = Math.round( (totalDeviations / totalMealCarbs)*100 )/100;
    }
    // only adjust by 10%
    newCSF = ( 0.9 * CSF ) + ( 0.1 * fullNewCSF );
    // safety cap CSF
    if (typeof(pumpCSF) !== 'undefined') {
        var maxCSF = pumpCSF * autotuneMax;
        var minCSF = pumpCSF * autotuneMin;
        if (newCSF > maxCSF) {
            console.error("Limiting CSF to",maxCSF.toFixed(2),"(which is",autotuneMax,"* pump CSF of",pumpCSF,")");
            newCSF = maxCSF;
        } else if (newCSF < minCSF) {
            console.error("Limiting CSF to",minCSF.toFixed(2),"(which is",autotuneMin,"* pump CSF of",pumpCSF,")");
            newCSF = minCSF;
        } //else { console.error("newCSF",newCSF,"is close enough to",pumpCSF); }
    }
    newCSF = Math.round( newCSF * 1000 ) / 1000;
    console.error("totalMealCarbs:",totalMealCarbs,"totalDeviations:",totalDeviations,"fullNewCSF:",fullNewCSF,"newCSF:",newCSF);
    // this is where CSF is set based on the outputs
    CSF = newCSF;

    // reconstruct updated version of previousAutotune as autotuneOutput
    autotuneOutput = previousAutotune;
    autotuneOutput.basalprofile = basalProfile;
    isfProfile.sensitivities[0].sensitivity = ISF;
    autotuneOutput.isfProfile = isfProfile;
    autotuneOutput.sens = ISF;
    autotuneOutput.csf = CSF;
    carbRatio = ISF / CSF;
    carbRatio = Math.round( carbRatio * 1000 ) / 1000;
    autotuneOutput.carb_ratio = carbRatio;

    return autotuneOutput;
}

// From https://gist.github.com/IceCreamYou/6ffa1b18c4c8f6aeaad2
// Returns the value at a given percentile in a sorted numeric array.
// "Linear interpolation between closest ranks" method
autotune.percentile = function percentile(arr, p) {
    if (arr.length === 0) return 0;
    if (typeof p !== 'number') throw new TypeError('p must be a number');
    if (p <= 0) return arr[0];
    if (p >= 1) return arr[arr.length - 1];

    var index = arr.length * p,
        lower = Math.floor(index),
        upper = lower + 1,
        weight = index % 1;

    if (upper >= arr.length) return arr[lower];
    return arr[lower] * (1 - weight) + arr[upper] * weight;
}

// Returns the percentile of the given value in a sorted numeric array.
autotune.percentRank = function percentRank(arr, v) {
    if (typeof v !== 'number') throw new TypeError('v must be a number');
    for (var i = 0, l = arr.length; i < l; i++) {
        if (v <= arr[i]) {
            while (i < l && v === arr[i]) i++;
            if (i === 0) return 0;
            if (v !== arr[i-1]) {
                i += (v - arr[i-1]) / (arr[i] - arr[i-1]);
            }
            return i / l;
        }
    }
    return 1;
}
