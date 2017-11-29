
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

function calcTempTreatments (inputs) {
  var pumpHistory = inputs.history;
  var profile_data = inputs.profile;
    var tempHistory = [];
    var tempBoluses = [];
    var now = new Date();
    var timeZone = now.toString().match(/([-\+][0-9]+)\s/)[1];

    // Pick relevant events for processing and clean the data

    for (var i=0; i < pumpHistory.length; i++) {
        var current = pumpHistory[i];
        //if(pumpHistory[i].date < time) {
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
                var date = current.date;
                if (i>0 && pumpHistory[i-1].date == date && pumpHistory[i-1]._type == "TempBasalDuration") {
                    var duration = pumpHistory[i-1]['duration (min)'];
                } else if (i+1<pumpHistory.length && pumpHistory[i+1].date == date && pumpHistory[i+1]._type == "TempBasalDuration") {
                    var duration = pumpHistory[i+1]['duration (min)'];
                } else { console.error("No duration found for "+rate+" U/hr basal"+date, pumpHistory[i - 1], current, pumpHistory[i + 1]); }
                var temp = {};
                temp.rate = rate;
                temp.timestamp = current.timestamp;
                temp.started_at = new Date(tz(temp.timestamp));
                temp.date = temp.started_at.getTime();
                temp.duration = duration;
                tempHistory.push(temp);
            }
        //}
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
