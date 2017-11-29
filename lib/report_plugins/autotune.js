'use strict';

var _ = require('lodash');
var moment = window.moment;
var times = require('../times');
var d3 = (global && global.d3) || require('d3');
var tz = require('moment-timezone');
var lastResult = null;
var autotune_prep = require('./autotune/autotune-prep');
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
    + '<input type="checkbox" id="compute_autotune">Compute autotune<br>'
    + '<div id="autotune-report"></div>'
    ;
    return ret;
};

autotune.css =
    '#autotune-report .autotune-report {'
  + '  border-spacing: 0;'
  + '}'
  + '#autotune-report .autotune-report th {'
  + '  width: 160px;'
  + '  border-bottom: 1px solid black;'
  + '  background: #b7b7b7'
  + '}'
  + '#autotune-report .autotune-report tr:nth-child(even) {'
  + '  background: #efefef;'
  + '}'
  + '#autotune-report .autotune-report td {'
  + '  width: 160px;'
  + '  padding: 4px 0;'
  + '}'

autotune.prepareHtml = function autotunePrepareHtml(sorteddaystoshow) {
};

function appendMainRecords(table, header, current, recommended, translate) {
  var tr = $('<tr/>');
  $('<td>' + translate(header) + '</td>').appendTo(tr);
  $('<td>' + current + '</td>').appendTo(tr);
  $('<td>' + recommended + '</td>').appendTo(tr);
  var td = $('<td/>')
  appendArrowIcon(td, current, recommended);
  td.appendTo(tr);
  tr.appendTo(table);
}

function getCurrentISF(store) {
  return store.sens[0].value;
}

function getCurrentCSF(store) {
  return getCurrentISF(store) / getCurrentCarbRatio(store);
}

function getCurrentCarbRatio(store) {
  return store.carbratio[0].value;
}

function roundNum(num) {
  return Number(num).toFixed(3);
}

function appendArrowIcon(td, current, recommended) {
  var icon = $('<img/>');
  if (recommended > current) {
    $('<img src="/images/up_arrow.png" />').appendTo(td);
  } else if (recommended < current) {
    $('<img src="/images/down_arrow.png" />').appendTo(td);
  }
}

function findActiveProfiles(profiles, sorteddaystoshow) {
  var result = {};
  result.activeIndex = -1;
  result.manyActive = false;

  var dateFrom = new Date(sorteddaystoshow[0]);
  var dateTo = new Date(sorteddaystoshow[sorteddaystoshow.length-1]);
  var sortedProfiles = [];
  for (i = 0; i < profiles.length; i++) {
    var record = {};
    record.profileIndex = i;
    splittedString = profiles[i].startDate.split("T");
    record.startDate = new Date(splittedString[0]);
    sortedProfiles.push(record);
  }
  sortedProfiles.sort(function (r1, r2) {
    return (r1.startDate < r2.startDate) ? -1 : ((r1.startDate > r2.startDate) ? 1 : 0);
  });
  for (i = 0; i < sortedProfiles.length; i++) {
    var profile = sortedProfiles[i];
    if (profile.startDate <= dateFrom) {
      result.activeIndex = profile.profileIndex;
      continue;
    }
    if (profile.startDate >= dateFrom && profile.startDate <= dateTo)
      result.manyActive = true;
    if (profile.startDate > dateFrom)
      break;
  }

  return result;
}

function getHourMinuteText(hour, minute)
{
  var text = "";
  if (hour < 10)
    text += "0";
  text += hour.toString(); 
  text += ":";
  if (minute < 10)
    text += "0";
  text += minute.toString();
  return text;  
}

function findBasalRecord(data, time)
{
  for(i = 0; i < data.length; i++)
  {
    if (data[i].time == time)
      return data[i];
  }
  return null;
}

function findRecommendedRecord(data, minutes) {
  for(i = 0; i < data.length; i++)
  {
    if (data[i].minutes == minutes)
      return data[i];
  }
  return null;
}

autotune.report = function report_autotune(datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var report_plugins = Nightscout.report_plugins;

  if (!$('#compute_autotune').is(':checked')) return;

  var profileRecords = datastorage.profiles;

  var report = $('#autotune-report');
  report.empty();

  var foundActiveProfile = findActiveProfiles(datastorage.profiles, sorteddaystoshow);
  if (foundActiveProfile.activeIndex < 0 || foundActiveProfile.manyActive)
  {
    // Show error
    $('<div class="error">' + "Error: Many profiles are active during choosen period." + "</div>").appendTo(report);
    return;
  }

  var table = $('<table class="centeraligned autotune-report">');
  report.append(table);

  var thead = $('<tr/>');
  $('<th/>').appendTo(thead);
  $('<th>' + translate('Current') + '</th>').appendTo(thead);
  $('<th>' + translate('Recommended') + '</th>').appendTo(thead);
  $('<th/>').appendTo(thead);
  thead.appendTo(table);

  var profile = profileRecords[foundActiveProfile.activeIndex];
  var store = profile.store[profile.defaultProfile];

  const re = /\d{4}-\d{2}-\d{2}/g;
  var keys = _.filter(Object.keys(datastorage), function (key) { return key.match(re)});

  var convertedProfile = autotune.convertProfile(profile);
  var opts = {
        profile: convertedProfile //inputs.profile
      , history: _.flatMap(keys, function(key){return datastorage[key].treatments;}) //inputs.history
      , glucose: _.flatMap(keys, function(key){return datastorage[key].sgv;})//inputs.glucose
      , prepped_glucose: undefined// inputs.prepped_glucose
      , basalprofile: convertedProfile.basalprofile
      , carbs: []
  };

  var prepared = autotune_prep(opts);

  var inputs = {
        preppedGlucose: prepared
      , previousAutotune: convertedProfile
      , pumpProfile: convertedProfile
  };

  var result = autotune.tune(inputs);

  appendMainRecords(table, 'ISF', roundNum(getCurrentISF(store)), result.sens, translate);
  appendMainRecords(table, 'CSF', roundNum(getCurrentCSF(store)), result.csf, translate);
  appendMainRecords(table, 'Carb Ratio', roundNum(getCurrentCarbRatio(store)), result.carb_ratio, translate);

  var trBasalProfile = $('<tr/>');
  $('<td>' + translate('Basal Profile') + '</td>').appendTo(trBasalProfile);
  $('<td/>').appendTo(trBasalProfile);
  $('<td/>').appendTo(trBasalProfile);
  $('<td/>').appendTo(trBasalProfile);
  trBasalProfile.appendTo(table);

  var lastBasalRecord;
  for (iTime = 0; iTime < 24*2; iTime++) {
    var time = getHourMinuteText(Math.floor(iTime / 2), (iTime % 2) * 30);
    var basalRecord = findBasalRecord(store.basal, time);
    var recommendedRecord = findRecommendedRecord(result.basalprofile, iTime*30);

    var tr = $('<tr/>');
    $('<td>' + time + '</td>').appendTo(tr);
    if (basalRecord !== null) {
      lastBasalRecord = basalRecord;
      $('<td>' + basalRecord.value + '</td>').appendTo(tr);
    }
    else {
      $('<td/>').appendTo(tr);
    }
    if (recommendedRecord !== null) {
      var criticalLimit = 1.2;
      var style = "";
      if (lastBasalRecord !== null) {
        var wasCriticalChange = false;
        if (lastBasalRecord.value < recommendedRecord.rate)
        {
          wasCriticalChange = (recommendedRecord.rate / lastBasalRecord.value >= criticalLimit);
        }
        else if (lastBasalRecord.value > recommendedRecord.rate) {
          wasCriticalChange = (lastBasalRecord.value / recommendedRecord.rate >= criticalLimit);
        }
        if (wasCriticalChange)
          style = "background-color: #FF9999";
      }
      $('<td style="' + style + '">' + recommendedRecord.rate + '</td>').appendTo(tr);
    }
    else {
      $('<td/>').appendTo(tr);
    }
    var lastTd = $('<td/>').appendTo(tr);

    if (recommendedRecord && lastBasalRecord) {
      appendArrowIcon(lastTd, lastBasalRecord.value, recommendedRecord.rate);
    }

    tr.appendTo(table)
  }
};

autotune.convertBasal = function convertBasal(item)
{
    var convertedBasal = {
      "start": item.time + ":00",
      "minutes": Math.round(item.timeAsSeconds / 60),
      "rate": item.value
  };
  return convertedBasal;
}

autotune.convertProfile = function convertProfile(profile)
{
    var autotuneProfile =
    {
      "min_5m_carbimpact": 3,
      "dia": profile.store.Default.dia,
      "basalprofile": _.map(profile.store.Default.basal, autotune.convertBasal),
      "isfProfile": {
        "sensitivities": [
          {
              "i": 0,
              "start": profile.store.Default.sens[0].time + ":00",
              "sensitivity": profile.store.Default.sens[0].value,
              "offset": 0,
              "x": 0,
              "endOffset": 1440
          }
        ]
      },
      "carb_ratio": profile.store.Default.carbratio[0].value,
      "autosens_max": 1.2,
      "autosens_min": 0.7
  };
  return autotuneProfile;
}

autotune.isfLookup = function isfLookup(isf_data, timestamp) {

    var nowDate = timestamp;

    if (typeof(timestamp) === 'undefined') {
      nowDate = new Date();
    }

    var nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();

	if (lastResult && nowMinutes >= lastResult.offset && nowMinutes < lastResult.endOffset) {
	    return lastResult.sensitivity;
	}

    isf_data = _.sortBy(isf_data.sensitivities, function(o) { return o.offset; });

    var isfSchedule = isf_data[isf_data.length - 1];

    if (isf_data[0].offset != 0 || isf_data[0].i != 0 || isf_data[0].x != 0 || isf_data[0].start != "00:00:00") {
        return -1;
    }

	var endMinutes = 1440;

    for (var i = 0; i < isf_data.length - 1; i++) {
        var currentISF = isf_data[i];
        var nextISF = isf_data[i+1];
        if (nowMinutes >= currentISF.offset && nowMinutes < nextISF.offset) {
            endMinutes = nextISF.offset;
            isfSchedule = isf_data[i];
            break;
        }
    }

    lastResult = isfSchedule;
    lastResult.endOffset = endMinutes;

    return isfSchedule.sensitivity;
}

autotune.arrayHasElementWithSameTimestampAndProperty = function arrayHasElementWithSameTimestampAndProperty(array,t,propname) {
    for (var j=0; j < array.length; j++) {
        var element = array[j];
        if (element.timestamp == t && element[propname] != undefined) return true;
    }
    return false;
}

/* Return basal rate(U / hr) at the provided timeOfDay */
autotune.basalLookup = function basalLookup (schedules, now) {

    var nowDate = now;

    if (typeof(now) === 'undefined') {
      nowDate = new Date();
    }

    var basalprofile_data = _.sortBy(schedules, function(o) { return o.i; });
    var basalRate = basalprofile_data[basalprofile_data.length-1].rate
    if (basalRate == 0) {
        console.error("ERROR: bad basal schedule",schedules);
        return;
    }
    var nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();

    for (var i = 0; i < basalprofile_data.length - 1; i++) {
        if ((nowMinutes >= basalprofile_data[i].minutes) && (nowMinutes < basalprofile_data[i + 1].minutes)) {
            basalRate = basalprofile_data[i].rate;
            break;
        }
    }
    return Math.round(basalRate*1000)/1000;
}

autotune.maxDailyBasal = function maxDailyBasal (inputs) {
    var maxRate = _.maxBy(inputs.basals,function(o) { return Number(o.rate); });
    return (Number(maxRate.rate) *1000)/1000;
}

/*Return maximum daily basal rate(U / hr) from profile.basals */
autotune.maxBasalLookup = function maxBasalLookup (inputs) {
    return inputs.settings.maxBasal;
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
    p50deviation = autotune.percentile(deviations, 0.50);
    p50BGI = autotune.percentile(BGIs, 0.50);
    p50ratios = Math.round( autotune.percentile(ratios, 0.50) * 1000)/1000;
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
