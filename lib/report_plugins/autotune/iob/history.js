
var tz = require('moment-timezone');
var basalprofile = require('../profile/basal.js');
var _ = require('lodash');
var moment = require('moment');

function splitTimespanWithOneSplitter(event,splitter) {

    var resultArray = [event];

    if (splitter.type === 'recurring') {

        var startMinutes = event.started_at.getHours() * 60 + event.started_at.getMinutes();
        var endMinutes = startMinutes + event.duration;

        // 1440 = one day; no clean way to check if the event overlaps midnight
        // so checking if end of event in minutes is past midnight

        if (event.duration > 30 || (startMinutes < splitter.minutes && endMinutes > splitter.minutes) || (endMinutes > 1440 && splitter.minutes < (endMinutes - 1440))) {

            var event1 = _.cloneDeep(event);
            var event2 = _.cloneDeep(event);

            var event1Duration = 0;

            if (event.duration > 30) {
                event1Duration = 30;
            } else {
                var splitPoint = splitter.minutes;
                if (endMinutes > 1440) { splitPoint = 1440; }
                event1Duration = splitPoint - startMinutes;
            }

            var event1EndDate = moment(event.started_at).add(event1Duration,'minutes');

            event1.duration = event1Duration;

            event2.duration  = event.duration - event1Duration;
            event2.timestamp = event1EndDate.format();
            event2.started_at = new Date(event2.timestamp);
            event2.date = event2.started_at.getTime();

            resultArray = [event1,event2];
        }
    }

    return resultArray;
}

function splitTimespan(event, splitterMoments) {

    var results = [event];

    var splitFound = true;

    while(splitFound) {

        var resultArray = [];
        splitFound = false;

        _.forEach(results,function split(o) {
            _.forEach(splitterMoments,function split(p) {
                var splitResult = splitTimespanWithOneSplitter(o,p);
                if (splitResult.length > 1) {
                    resultArray = resultArray.concat(splitResult);
                    splitFound = true;
                    return false;
                }
            });

            if (!splitFound) resultArray = resultArray.concat([o]);

        });

        results = resultArray;
    }

    return results;
}

function calcTempTreatments (inputs, zeroTempDuration) {
    var pumpHistory = inputs.history;
    var profile_data = inputs.profile;
    var autosens_data = inputs.autosens;
    var tempHistory = [];
    var tempBoluses = [];
    var now = new Date();
    var timeZone = now.toString().match(/([-\+][0-9]+)\s/)[1];

    // Pick relevant events for processing and clean the data

    for (var i=0; i < pumpHistory.length; i++) {
        var current = pumpHistory[i];
        if (current.bolus && current.bolus._type == "Bolus") {
            var temp = current;
            current = temp.bolus;
        }
        if (current._type == "Bolus") {
            var temp = {};
            temp.timestamp = current.timestamp;
            temp.started_at = new Date(tz(current.timestamp));
            temp.date = temp.started_at.getTime();
            temp.insulin = current.amount;
            tempBoluses.push(temp);
        } else if (current.eventType == "Meal Bolus" || current.eventType == "Correction Bolus" || current.eventType == "Snack Bolus" || current.eventType == "Bolus Wizard") {
            //imports treatments entered through Nightscout Care Portal
            //"Bolus Wizard" refers to the Nightscout Bolus Wizard, not the Medtronic Bolus Wizard
            var temp = {};
            temp.timestamp = current.created_at;
            temp.started_at = new Date(tz(temp.timestamp));
            temp.date = temp.started_at.getTime();
            temp.insulin = current.insulin;
            tempBoluses.push(temp);
        } else if (current.enteredBy == "xdrip") {
            var temp = {};
            temp.timestamp = current.timestamp;
            temp.started_at = new Date(tz(current.timestamp));
            temp.date = temp.started_at.getTime();
            temp.insulin = current.insulin;
            tempBoluses.push(temp);
        } else if (current.enteredBy =="HAPP_App" && current.insulin) {
            var temp = {};
            temp.timestamp = current.created_at;
            temp.started_at = new Date(tz(current.timestamp));
            temp.date = temp.started_at.getTime();
            temp.insulin = current.insulin;
            tempBoluses.push(temp);
        } else if (current.eventType == "Temp Basal" && current.enteredBy=="HAPP_App") {
            var temp = {};
            temp.rate = current.absolute;
            temp.duration = current.duration;
            temp.timestamp = current.created_at;
            temp.started_at = new Date(tz(temp.timestamp));
            temp.date = temp.started_at.getTime();
            temp.duration = current.duration;
            tempHistory.push(temp);
        } else if (current.eventType == "Temp Basal") {
            var temp = {};
            temp.rate = current.rate;
            temp.duration = current.duration;
            temp.timestamp = current.timestamp;
            temp.started_at = new Date(tz(temp.timestamp));
            temp.date = temp.started_at.getTime();
            temp.duration = current.duration;
            tempHistory.push(temp);
        } else if (current._type == "TempBasal") {
            if (current.temp == 'percent') {
                continue;
            }
            var rate = current.rate;
            var timestamp = current.timestamp;
            var duration;
            if (i>0 && pumpHistory[i-1].timestamp == timestamp && pumpHistory[i-1]._type == "TempBasalDuration") {
                duration = pumpHistory[i-1]['duration (min)'];
            } else {
                for (var iter=0; iter < pumpHistory.length; iter++) {
                    if (pumpHistory[iter].timestamp == timestamp && pumpHistory[iter]._type == "TempBasalDuration") {
                            duration = pumpHistory[iter]['duration (min)'];
                            break;
                    }
                }

                if (duration == undefined) {
                    console.error("No duration found for "+rate+" U/hr basal "+timestamp, pumpHistory[i - 1], current, pumpHistory[i + 1]);
                }
            }
            var temp = {};
            temp.rate = rate;
            temp.timestamp = current.timestamp;
            temp.started_at = new Date(tz(temp.timestamp));
            temp.date = temp.started_at.getTime();
            temp.duration = duration;
            tempHistory.push(temp);
        }
        // Add a temp basal cancel event to ignore future temps and reduce predBG oscillation
        var temp = {};
        temp.rate = 0;
        // start the zero temp 1m in the future to avoid clock skew
        temp.started_at = new Date(now.getTime() + (1 * 60 * 1000));
        temp.date = temp.started_at.getTime();
        if (zeroTempDuration) {
            temp.duration = zeroTempDuration;
        } else {
            temp.duration = 0;
        }
        tempHistory.push(temp);
    }

    // Check for overlapping events and adjust event lengths in case of overlap

    tempHistory = _.sortBy(tempHistory, 'date');

    for (var i=0; i+1 < tempHistory.length; i++) {
        if (tempHistory[i].date + tempHistory[i].duration*60*1000 > tempHistory[i+1].date) {
            tempHistory[i].duration = (tempHistory[i+1].date - tempHistory[i].date)/60/1000;
        }
    }

    // Create an array of moments to slit the temps by
    // currently supports basal changes
    // TODO: add pump suspends

    var splitterEvents = [];

    _.forEach(profile_data.basalprofile,function addSplitter(o) {
        var splitterEvent = {};
        splitterEvent.type = 'recurring';
        splitterEvent.minutes = o.minutes;
        splitterEvents.push(splitterEvent);
    });

    // iterate through the events and split if needed

    var splitHistory = [];

    _.forEach(tempHistory, function splitEvent(o) {
        splitHistory = splitHistory.concat(splitTimespan(o,splitterEvents));
    });

    tempHistory = _.sortBy(tempHistory, function(o) { return o.date; });
    splitHistory = _.sortBy(splitHistory, function(o) { return o.date; });

    tempHistory = splitHistory;

    // iterate through the temp basals and create bolus events from temps that affect IOB

    var tempBolusSize;

    for (var i=0; i < tempHistory.length; i++) {

        var currentItem = tempHistory[i];

        if (currentItem.duration > 0) {

            var currentRate = profile_data.current_basal;
            if (!_.isEmpty(profile_data.basalprofile)) {
                currentRate = basalprofile.basalLookup(profile_data.basalprofile,new Date(currentItem.timestamp));
            }

            if (typeof profile_data.min_bg !== 'undefined' && typeof profile_data.max_bg !== 'undefined') {
                target_bg = (profile_data.min_bg + profile_data.max_bg) / 2;
            }
            //if (profile_data.temptargetSet && target_bg > 110) {
                //sensitivityRatio = 2/(2+(target_bg-100)/40);
                //currentRate = profile_data.current_basal * sensitivityRatio;
            //}
            var sensitivityRatio;
            var profile = profile_data;
            var normalTarget = 100; // evaluate high/low temptarget against 100, not scheduled basal (which might change)
            if ( profile.half_basal_exercise_target ) {
                var halfBasalTarget = profile.half_basal_exercise_target;
            } else {
                var halfBasalTarget = 160; // when temptarget is 160 mg/dL, run 50% basal (120 = 75%; 140 = 60%)
            }
            if ( profile.exercise_mode && profile.temptargetSet && target_bg >= normalTarget + 5 ) {
                // w/ target 100, temp target 110 = .89, 120 = 0.8, 140 = 0.67, 160 = .57, and 200 = .44
                // e.g.: Sensitivity ratio set to 0.8 based on temp target of 120; Adjusting basal from 1.65 to 1.35; ISF from 58.9 to 73.6
                var c = halfBasalTarget - normalTarget;
                sensitivityRatio = c/(c+target_bg-normalTarget);
            } else if (typeof autosens_data !== 'undefined' ) {
                sensitivityRatio = autosens_data.ratio;
                //process.stderr.write("Autosens ratio: "+sensitivityRatio+"; ");
            }
            if ( sensitivityRatio ) {
                currentRate = profile_data.current_basal * sensitivityRatio;
            }

            var netBasalRate = currentItem.rate - currentRate;
            if (netBasalRate < 0) { tempBolusSize = -0.05; }
            else { tempBolusSize = 0.05; }
            var netBasalAmount = Math.round(netBasalRate*currentItem.duration*10/6)/100
            var tempBolusCount = Math.round(netBasalAmount / tempBolusSize);
            var tempBolusSpacing = currentItem.duration / tempBolusCount;
            for (var j=0; j < tempBolusCount; j++) {
                var tempBolus = {};
                tempBolus.insulin = tempBolusSize;
                tempBolus.date = currentItem.date + j * tempBolusSpacing*60*1000;
                tempBolus.created_at = new Date(tempBolus.date);
                tempBoluses.push(tempBolus);
            }
        }
    }
    var all_data =  [ ].concat(tempBoluses).concat(tempHistory);
    all_data = _.sortBy(all_data, 'date');
    return all_data;
}
exports = module.exports = calcTempTreatments;
