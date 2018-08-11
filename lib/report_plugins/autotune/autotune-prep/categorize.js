var tz = require('moment-timezone');
var basal = require('../profile/basal');
var getIOB = require('../iob');
var ISF = require('../profile/isf');
var find_insulin = require('../iob/history');
var dosed = require('./dosed');

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
    // this sorts the glucose collection in order.
    glucoseData.sort(function (a, b) {
        var aDate = new Date(tz(a.date));
        var bDate = new Date(tz(b.date));
        //console.error(aDate);
        return bDate.getTime() - aDate.getTime();
    });
    // if (typeof(opts.preppedGlucose) !== 'undefined') {
        // var preppedGlucoseData = opts.preppedGlucose;
    // }
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
    var CSFGlucoseData = [];
    var ISFGlucoseData = [];
    var basalGlucoseData = [];
    var UAMGlucoseData = [];
    var CRData = [];

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
            if (! bucketedData[j].dateString) {
                bucketedData[j].dateString = BGTime.toISOString();
            }
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
    var calculatingCR = false;
    var absorbing = 0;
    var uam = 0; // unannounced meal
    var mealCOB = 0;
    var mealCarbs = 0;
    var CRCarbs = 0;
    var type="";
    // main for loop
    var fullHistory = IOBInputs.history;
    for (var i=bucketedData.length-5; i > 0; --i) {
        var glucoseDatum = bucketedData[i];
        //console.error(glucoseDatum);
        var BGDate = new Date(glucoseDatum.date);
        var BGTime = BGDate.getTime();
        // As we're processing each data point, go through the treatment.carbs and see if any of them are older than
        // the current BG data point.  If so, add those carbs to COB.
        var treatment = treatments[treatments.length-1];
        var myCarbs = 0;
        if (treatment) {
            var treatmentDate = new Date(tz(treatment.timestamp));
            var treatmentTime = treatmentDate.getTime();
            //console.error(treatmentDate);
            if ( treatmentTime < BGTime ) {
                if (treatment.carbs >= 1) {
                    mealCOB += parseFloat(treatment.carbs);
                    mealCarbs += parseFloat(treatment.carbs);
                    myCarbs = treatment.carbs;
                }
                treatments.pop();
            }
        }

        var BG;
        var avgDelta;
        var delta;
        // TODO: re-implement interpolation to avoid issues here with gaps
        // calculate avgDelta as last 4 datapoints to better catch more rises after COB hits zero
        if (typeof(bucketedData[i].glucose) != 'undefined' && typeof(bucketedData[i+4].glucose) != 'undefined') {
            //console.error(bucketedData[i]);
            BG = bucketedData[i].glucose;
            if ( BG < 40 || bucketedData[i+4].glucose < 40) {
                //process.stderr.write("!");
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
        // trim down IOBInputs.history to just the data for 6h prior to BGDate
        //console.error(IOBInputs.history[0].created_at);
        var newHistory = [];
        for (h=0; h<fullHistory.length; h++) {
            var hDate = new Date(fullHistory[h].created_at)
            //console.error(fullHistory[i].created_at, hDate, BGDate, BGDate-hDate);
            //if (h == 0 || h == fullHistory.length - 1) {
                //console.error(hDate, BGDate, hDate-BGDate)
            //}
            if (BGDate-hDate < 6*60*60*1000 && BGDate-hDate > 0) {
                //process.stderr.write("i");
                //console.error(hDate);
                newHistory.push(fullHistory[h]);
            }
        }
        IOBInputs.history = newHistory;
        // process.stderr.write("" + newHistory.length + " ");
        //console.error(newHistory[0].created_at,newHistory[newHistory.length-1].created_at,newHistory.length);


        // for IOB calculations, use the average of the last 4 hours' basals to help convergence;
        // this helps since the basal this hour could be different from previous, especially if with autotune they start to diverge.
        // use the pumpbasalprofile to properly calculate IOB during periods where no temp basal is set
        currentPumpBasal = basal.basalLookup(opts.pumpbasalprofile, BGDate);
        BGDate1hAgo = new Date(BGTime-1*60*60*1000);
        BGDate2hAgo = new Date(BGTime-2*60*60*1000);
        BGDate3hAgo = new Date(BGTime-3*60*60*1000);
        basal1hAgo = basal.basalLookup(opts.pumpbasalprofile, BGDate1hAgo);
        basal2hAgo = basal.basalLookup(opts.pumpbasalprofile, BGDate2hAgo);
        basal3hAgo = basal.basalLookup(opts.pumpbasalprofile, BGDate3hAgo);
        var sum = [currentPumpBasal,basal1hAgo,basal2hAgo,basal3hAgo].reduce(function(a, b) { return a + b; });
        IOBInputs.profile.currentBasal = Math.round((sum/4)*1000)/1000;

        // this is the current autotuned basal, used for everything else besides IOB calculations
        currentBasal = basal.basalLookup(opts.basalprofile, BGDate);

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
            // Store the COB, and use it as the starting point for the next data point.
            mealCOB = Math.max(0, mealCOB-absorbed);
        }


        // Calculate carb ratio (CR) independently of CSF and ISF
        // Use the time period from meal bolus/carbs until COB is zero and IOB is < currentBasal/2
        // For now, if another meal IOB/COB stacks on top of it, consider them together
        // Compare beginning and ending BGs, and calculate how much more/less insulin is needed to neutralize
        // Use entered carbs vs. starting IOB + delivered insulin + needed-at-end insulin to directly calculate CR.

        if (mealCOB > 0 || calculatingCR ) {
            // set initial values when we first see COB
            CRCarbs += myCarbs;
            if (!calculatingCR) {
                CRInitialIOB = iob.iob;
                CRInitialBG = glucoseDatum.glucose;
                CRInitialCarbTime = new Date(glucoseDatum.date);
                console.error("CRInitialIOB:",CRInitialIOB,"CRInitialBG:",CRInitialBG,"CRInitialCarbTime:",CRInitialCarbTime);
            }
            // keep calculatingCR as long as we have COB or enough IOB
            if ( mealCOB > 0 && i>1 ) {
                calculatingCR = true;
            } else if ( iob.iob > currentBasal/2 && i>1 ) {
                calculatingCR = true;
            // when COB=0 and IOB drops low enough, record end values and be done calculatingCR
            } else {
                CREndIOB = iob.iob;
                CREndBG = glucoseDatum.glucose;
                CREndTime = new Date(glucoseDatum.date);
                console.error("CREndIOB:",CREndIOB,"CREndBG:",CREndBG,"CREndTime:",CREndTime);
                var CRDatum = {
                    CRInitialIOB: CRInitialIOB
                ,   CRInitialBG: CRInitialBG
                ,   CRInitialCarbTime: CRInitialCarbTime
                ,   CREndIOB: CREndIOB
                ,   CREndBG: CREndBG
                ,   CREndTime: CREndTime
                ,   CRCarbs: CRCarbs
                };
                //console.error(CRDatum);

                var CRElapsedMinutes = Math.round((CREndTime - CRInitialCarbTime) / 1000 / 60);
                //console.error(CREndTime - CRInitialCarbTime, CRElapsedMinutes);
                if ( CRElapsedMinutes < 60 || ( i==1 && mealCOB > 0 ) ) {
                    console.error("Ignoring",CRElapsedMinutes,"m CR period.");
                } else {
                    CRData.push(CRDatum);
                }

                CRCarbs = 0;
                calculatingCR = false;
            }
        }


        // If mealCOB is zero but all deviations since hitting COB=0 are positive, assign those data points to CSFGlucoseData
        // Once deviations go negative for at least one data point after COB=0, we can use the rest of the data to tune ISF or basals
        if (mealCOB > 0 || absorbing || mealCarbs > 0) {
            // if meal IOB has decayed, then end absorption after this data point unless COB > 0
            if ( iob.iob < currentBasal/2 ) {
                absorbing = 0;
            // otherwise, as long as deviations are positive, keep tracking carb deviations
            } else if (deviation > 0) {
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

          if ((iob.iob > currentBasal || uam) ) {
            if (deviation > 0) {
                uam = 1;
            } else {
                uam = 0;
            }
            if ( type != "uam" ) {
                glucoseDatum.uamAbsorption = "start";
                console.error(glucoseDatum.uamAbsorption,"uannnounced meal absorption");
            }
            type="uam";
            UAMGlucoseData.push(glucoseDatum);
          } else {
            if ( type === "uam" ) {
                console.error("end unannounced meal absorption");
            }


            // Go through the remaining time periods and divide them into periods where scheduled basal insulin activity dominates. This would be determined by calculating the BG impact of scheduled basal insulin (for example 1U/hr * 48 mg/dL/U ISF = 48 mg/dL/hr = 5 mg/dL/5m), and comparing that to BGI from bolus and net basal insulin activity.
            // When BGI is positive (insulin activity is negative), we want to use that data to tune basals
            // When BGI is smaller than about 1/4 of basalBGI, we want to use that data to tune basals
            // When BGI is negative and more than about 1/4 of basalBGI, we can use that data to tune ISF,
            // unless avgDelta is positive: then that's some sort of unexplained rise we don't want to use for ISF, so that means basals
            if (basalBGI > -4 * BGI) {
                type="basal";
                basalGlucoseData.push(glucoseDatum);
            } else {
                if ( avgDelta > 0 && avgDelta > -2*BGI ) {
                    //type="unknown"
                    type="basal"
                    basalGlucoseData.push(glucoseDatum);
                } else {
                    type="ISF";
                    ISFGlucoseData.push(glucoseDatum);
                }
            }
          }
        }
        // debug line to print out all the things
        BGDateArray = BGDate.toString().split(" ");
        BGTime = BGDateArray[4];
        console.error(absorbing.toString(),"mealCOB:",mealCOB.toFixed(1),"mealCarbs:",mealCarbs,"basalBGI:",basalBGI.toFixed(1),"BGI:",BGI.toFixed(1),"IOB:",iob.iob.toFixed(1),"at",BGTime,"dev:",deviation,"avgDelta:",avgDelta,type);
    }

    var IOBInputs = {
        profile: profileData
    ,   history: opts.pumpHistory
    };
    var treatments = find_insulin(IOBInputs);
    CRData.forEach(function(CRDatum) {
        var dosedOpts = {
            treatments: treatments
            , profile: opts.profile
            , start: CRDatum.CRInitialCarbTime
            , end: CRDatum.CREndTime
        };
        var insulinDosed = dosed(dosedOpts);
        CRDatum.CRInsulin = insulinDosed.insulin;
        //console.error(CRDatum);
    });

    var CSFLength = CSFGlucoseData.length;
    var ISFLength = ISFGlucoseData.length;
    var UAMLength = UAMGlucoseData.length;
    var basalLength = basalGlucoseData.length;

    if (2*basalLength < UAMLength) {
        //console.error(basalGlucoseData, UAMGlucoseData);
        console.error("Warning: too many deviations categorized as UnAnnounced Meals");
        console.error("Adding",UAMLength,"UAM deviations to",basalLength,"basal ones");
        var basalGlucoseData = basalGlucoseData.concat(UAMGlucoseData);
        console.error("Adding",UAMLength,"UAM deviations to",ISFLength,"ISF ones");
        var ISFGlucoseData = ISFGlucoseData.concat(UAMGlucoseData);
        //console.error(ISFGlucoseData.length, UAMLength);
    }
    var basalLength = basalGlucoseData.length;
    var ISFLength = ISFGlucoseData.length;
    if ( 4*basalLength + ISFLength < CSFLength && ISFLength < 10 ) {
        console.error("Warning: too many deviations categorized as meals");
        //console.error("Adding",CSFLength,"CSF deviations to",basalLength,"basal ones");
        //var basalGlucoseData = basalGlucoseData.concat(CSFGlucoseData);
        console.error("Adding",CSFLength,"CSF deviations to",ISFLength,"ISF ones");
        var ISFGlucoseData = ISFGlucoseData.concat(CSFGlucoseData);
        CSFGlucoseData = [];
    }


    return {
        CRData: CRData,
        CSFGlucoseData: CSFGlucoseData,
        ISFGlucoseData: ISFGlucoseData,
        basalGlucoseData: basalGlucoseData
    };
}

exports = module.exports = categorizeBGDatums;
