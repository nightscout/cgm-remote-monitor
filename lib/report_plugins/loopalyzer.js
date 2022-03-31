'use strict';

//var _ = require('lodash');
var moment = window.moment;
//var times = require('../times');
//var d3 = (global && global.d3) || require('d3');

var loopalyzer = {
  name: 'loopalyzer'
  , label: 'Loopalyzer'
  , pluginType: 'report'
};

function init () {
  return loopalyzer;
}

module.exports = init;

var laDebug = false; // If we should print console.logs
var laVersion = '2019-02-02 v6';
var risingInterpolationGap = 6; // How large a gap in COB/IOB graph is allowed to be to be interpolated if end value is larger than start
var fallingInterpolationGap = 24; // And if less than start
var interpolationRatio = 1.25; // But do allow rising interpolation if gap larger than interpolationGap and end value is less than 10% larger than start

loopalyzer.html = function html (client) {
  var translate = client.translate;
  var ret = '';
  ret += '<h2>Loopalyzer&nbsp;&nbsp;<span id="loopalyzer-dateinfo"></span></h2>';
  ret += '<span id="loopalyzer-help">' + translate('The primary purpose of Loopalyzer is to visualise how the Loop closed loop system performs. It may work with other setups as well, both closed and open loop, and non loop. However depending on which uploader you use, how frequent it is able to capture your data and upload, and how it is able to backfill missing data some graphs may have gaps or even be completely empty. Always ensure the graphs look reasonable. Best is to view one day at a time and scroll through a number of days first to see.');
  ret += '<br/><br/>' + translate('Loopalyzer includes a time shift feature. If you for example have breakfast at 07:00 one day and at 08:00 the day after your average blood glucose curve these two days will most likely look flattened and not show the actual response after a breakfast. Time shift will compute the average time these meals were eaten and then shift all data (carbs, insulin, basal etc.) during both days the corresponding time difference so that both meals align with the average meal start time. ');
  ret += '<br/>' + translate('In this example all data from first day is pushed 30 minutes forward in time and all data from second day 30 minutes backward in time so it appears as if you had had breakfast at 07:30 both days. This allows you to see your actual average blood glucose response from a meal.');
  ret += '<br/></br>' + translate('Time shift highlights the period after the average meal start time in gray, for the duration of the DIA (Duration of Insulin Action). As all data points the entire day are shifted the curves outside the gray area may not be accurate.');
  ret += '<br/></br>' + translate('Note that time shift is available only when viewing multiple days.');
  ret += '<br/><br/><b>';
  ret += translate('To see this report, press SHOW while in this view');
  ret += '</b></span>';
  ret += '<span id="loopalyzer-notenoughdata" style="display:none;"><b>' + translate('Please select a maximum of' +
    ' two weeks duration and click Show again.') + '</b><br/><br/></span>';
  ret += '<div id="loopalyzer-buttons" style="display:none;">';
  ret += '<input type="checkbox" id="rp_loopalyzerprofiles">' + translate('Show profiles table') + '&nbsp;&nbsp;&nbsp;&nbsp;';
  ret += '<input type="checkbox" id="rp_loopalyzerpredictions">' + translate('Show predictions');
  ret += '<br/>';
  ret += '<span id="rp_loopalyzertimeshiftinput">'; /* So we can show only if viewing multiple days  style="display:none;" */
  ret += '<input type="checkbox" id="rp_loopalyzertimeshift">';
  ret += translate('Timeshift on meals larger than') + ' ';
  ret += '<input type="number" style="width: 3.5em" value="10" id="rp_loopalyzermincarbs">' + ' ' + translate('g carbs');
  ret += '&nbsp;' + translate('consumed between');
  ret += ' <select id="rp_loopalyzert1">';
  for (let i = 0; i < 24; i++) {
    const H = (i < 10 ? '0' : '') + i;
    ret += '  <option t1="' + H + ':00"' + (i == 6 ? ' selected' : '') + '>' + H + ':00</option>';
    ret += '  <option t1="' + H + ':30">' + H + ':30</option>';
  }
  ret += '</select>';
  ret += '  ' + translate('and');
  ret += ' <select id="rp_loopalyzert2">';
  for (let i = 0; i < 24; i++) {
    const H = (i < 10 ? '0' : '') + i;
    ret += '  <option t2="' + H + ':00"' + (i == 9 ? ' selected' : '') + '>' + H + ':00</option>';
    ret += '  <option t2="' + H + ':30">' + H + ':30</option>';
  }
  ret += '</select>';
  ret += '</span>'; /* timeShift */
  ret += '<br/><br/>';
  ret += '<input type="button" onclick="loopalyzerMoreBackward();" value="&lt;&lt;&lt;&nbsp;' + translate('Previous') + '">';
  ret += '<input type="button" onclick="loopalyzerBackward();" value="&lt;&nbsp;' + translate('Previous day') + '">';
  ret += '<input type="button" onclick="loopalyzerForward();" value="' + translate('Next day') + '&nbsp;&gt;">';
  ret += '<input type="button" onclick="loopalyzerMoreForward();" value="' + translate('Next') + '&nbsp;&gt;&gt;&gt;">';
  ret += '</div>'; /* loopalyzer-button */
  ret += '<div id="loopalyzer-charts">';
  ret += '  <div class="chart" id="loopalyzer-basal" style="height:100px;margin-bottom:-14px;"></div>';
  ret += '  <div class="chart" id="loopalyzer-bg" style="height:200px;margin-bottom:-14px;"></div>';
  ret += '  <div class="chart" id="loopalyzer-tempbasal" style="height:150px;margin-bottom:-14px;"></div>';
  ret += '  <div class="chart" id="loopalyzer-iob" style="height:150px;margin-bottom:-14px;"></div>';
  ret += '  <div class="chart" id="loopalyzer-cob" style="height:150px;"></div>';
  ret += '</div>';
  ret += '<div id="loopalyzer-profiles">';
  ret += '</div>';
  return ret;
};

loopalyzer.css =
  '#loopalyzer-charts, #loopalyzer-profiles { padding: 20px; } ' +
  '#loopalyzer-basal, #loopalyzer-bg, #loopalyzer-tempbasal, #loopalyzer-iob, #loopalyzer-cob, #loopalyzer-profiles {' +
  '  width: 100%;' +
  '  height: 100%;' +
  '}' +
  '#loopalyzer-profiles-table table { margin: 0 10px; border-collapse: collapse; border: 0px; }' +
  '#loopalyzer-profiles-table td { vertical-align: top; }' +
  '#loopalyzer-profiles-table td table { margin: 0 10px; border-collapse: collapse; border: 0px; }' +
  '#loopalyzer-profiles-table td caption { text-align: left; font-weight: bold; }' +
  '#loopalyzer-profiles-table td th { background-color: #4CAF50; color: white; }' +
  '#loopalyzer-profiles-table td td { text-align: right; vertical-align: top; padding: 0 1px; }' +
  '#loopalyzer-profiles-table td td td { padding: 1px 8px; }';

loopalyzer.prepareHtml = function loopalyzerPrepareHtml () {
  //  $('#loopalyzer-charts').append($('<table><tr><td><div id="loopalyzerchart"></div></td><td><div id="loopalyzerstatchart"></td></tr></table>'));
};

// loopalyzer.ss = require('simple-statistics');

//
// Functions to pull data from datastorage and prepare in bins
//
loopalyzer.getSGVs = function(datastorage, daysToShow) {
  var data = datastorage.allstatsrecords;
  var bins = loopalyzer.getEmptyBins();

  // Loop thru the days to show, for each day find the matching SGVs and insert into the bins entry array
  daysToShow.forEach(function(day) {
    var entries = []; // Array with all SGVs for this day, we'll fill this and then insert into the bins later
    for (let i = 0; i < 288; i++) entries.push(NaN); // Fill the array with NaNs so we have something in case we don't find an SGV
    var fromDate = moment(day);
    var toDate = moment(day);
    fromDate.set({ 'hours': 0, 'minutes': 0, 'seconds': 0, 'milliseconds': 0 });
    toDate.set({ 'hours': 0, 'minutes': 5, 'seconds': 0, 'milliseconds': 0 }); // toDate is 5 mins ahead
    for (let i = 0; i < 288; i++) {
      var found = false;
      data.some(function(record) {
        var recDate = moment(record.displayTime);
        if (!found && recDate.isAfter(fromDate) && recDate.isBefore(toDate)) {
          entries[i] = record.sgv;
          found = true;
        }
        return found; // Breaks .some loop if found is true
      })
      fromDate.add(5, 'minutes');
      toDate.add(5, 'minutes');
    }
    loopalyzer.addArrayToBins(bins, entries);
  });
  return bins;
}

loopalyzer.getBasals = function(datastorage, daysToShow, profile) {
  var bins = loopalyzer.getEmptyBins();

  daysToShow.forEach(function(day) {
    var dayStart = moment(day).startOf('day');
    var dayEnd = moment(day).endOf('day');
    var basals = [];
    for (var i = 0; i < 288; i++) basals.push(NaN); // Clear the basals by filling with NaNs

    var index = 0;
    for (var dt = dayStart; dt < dayEnd; dt.add(5, 'minutes')) {
      var basal = profile.getTempBasal(dt.toDate());
      if (basal)
        basals[index++] = basal.basal;
    }
    if (laDebug) console.log('getBasals ' + day, basals);
    loopalyzer.addArrayToBins(bins, basals);
  });
  return bins;
}

loopalyzer.getTempBasalDeltas = function(datastorage, daysToShow, profile) {
  var bins = loopalyzer.getEmptyBins();

  daysToShow.forEach(function(day) {
    var dayStart = moment(day).startOf('day');
    var dayEnd = moment(day).endOf('day');
    var temps = [];
    for (var i = 0; i < 288; i++) temps.push(NaN); // Clear the basals by filling with NaNs

    var index = 0;
    for (var dt = dayStart; dt < dayEnd; dt.add(5, 'minutes')) {
      var basal = profile.getTempBasal(dt.toDate());
      if (basal)
        temps[index++] = basal.tempbasal - basal.basal;
    }
    if (laDebug) console.log('getTempBasalDeltas ' + day, temps);
    loopalyzer.addArrayToBins(bins, temps);
  });
  return bins;
}

loopalyzer.getIOBs = function(datastorage, daysToShow, profile, client, treatments) {
  var iobStatusAvailable = client.plugins('iob').isDeviceStatusAvailable(datastorage.devicestatus);
  if (laDebug) console.log('getIOBs iobStatusAvailable=' + iobStatusAvailable);

  var bins = loopalyzer.getEmptyBins();

  daysToShow.forEach(function(day) {
    var dayStart = moment(day).startOf('day');
    var dayEnd = moment(day).endOf('day');
    var iobs = [];
    if (iobStatusAvailable) {
      // var dayStartMills = dayStart.milliseconds();
      for (var i = 0; i < 288; i++) iobs.push(NaN); // Clear the IOBs by filling with NaNs
      var iobArray = client.plugins('iob').IOBDeviceStatusesInTimeRange(datastorage.devicestatus, dayStart.valueOf(), dayEnd.valueOf());
      if (laDebug) console.log('getIOBs iobArray', iobArray);
      iobArray.forEach(function(entry) {
        var index = Math.floor(moment(entry.mills).diff(dayStart, 'minutes') / 5);
        iobs[index] = entry.iob;
      });

      if (daysToShow.length === 1) loopalyzer.fillNanWithTreatments(iobs, treatments);

      // Loop thru these entries and where no IOB has been found, interpolate between nearby to get a continuous array
      var startIndex = 0
        , stopIndex = 0;
      while (startIndex < iobs.length && isNaN(iobs[startIndex])) {
        startIndex++; // Advance start to the first real number
      }
      if (startIndex < iobs.length) {
        stopIndex = startIndex + 1;
        while (stopIndex < iobs.length) {
          while (stopIndex < iobs.length && isNaN(iobs[stopIndex])) {
            stopIndex++; // Advance stop to the first real number after start
          }
          if (stopIndex < iobs.length) {
            // Now we have real numbers at start and stop and NaNs in between
            // Compute the y=k*x+m = (y2-y1)/(x2-x1)*x+y1
            // Only interpolate on decreasing or steady, or on increasing if the gap is less than interpolationGap
            // if (stopIndex-startIndex<interpolationGap && (iobs[stopIndex] <= iobs[startIndex]*interpolationRatio || (stopIndex-startIndex<interpolationGap && iobs[startIndex]!==0))) {
            if (loopalyzer.canInterpolate(iobs, startIndex, stopIndex)) {
              var k = (iobs[stopIndex] - iobs[startIndex]) / (stopIndex - startIndex);
              var m = iobs[startIndex];
              for (var x = 0; x < (stopIndex - startIndex); x++) {
                iobs[x + startIndex] = k * x + m;
              }
            }
            startIndex = stopIndex;
            stopIndex++;
          }
        }
      }
    } else {
      for (var dt = dayStart; dt < dayEnd; dt.add(5, 'minutes')) {
        var iob = client.plugins('iob').calcTotal(datastorage.treatments, datastorage.devicestatus, profile, dt.toDate()).iob;
        iobs.push(iob);
      }
    }
    if (laDebug) console.log('getIOBs ' + day, iobs);
    loopalyzer.addArrayToBins(bins, iobs);
  });
  return bins;
}

loopalyzer.getCOBs = function(datastorage, daysToShow, profile, client, treatments) {
  var cobStatusAvailable = client.plugins('cob').isDeviceStatusAvailable(datastorage.devicestatus);
  if (laDebug) console.log('getCOBs cobStatusAvailable=' + cobStatusAvailable);

  var bins = loopalyzer.getEmptyBins();

  daysToShow.forEach(function(day) {
    var dayStart = moment(day).startOf('day');
    var dayEnd = moment(day).endOf('day');
    var cobs = [];
    if (cobStatusAvailable) {
      // var dayStartMills = dayStart.milliseconds();
      for (var i = 0; i < 288; i++) cobs.push(NaN); // Clear the COBs by filling with NaNs
      var cobArray = client.plugins('cob').COBDeviceStatusesInTimeRange(datastorage.devicestatus, dayStart.valueOf(), dayEnd.valueOf());
      if (laDebug) console.log('getCOBs cobArray', cobArray);
      cobArray.forEach(function(entry) {
        var index = Math.floor(moment(entry.mills).diff(dayStart, 'minutes') / 5);
        cobs[index] = entry.cob;
      });

      if (daysToShow.length === 1) loopalyzer.fillNanWithTreatments(cobs, treatments);

      // Loop thru these entries and where no COB has been found, interpolate between nearby to get a continuous array
      var startIndex = 0
        , stopIndex = 0
        , k = 0
        , m = 0;

      while (startIndex < cobs.length && isNaN(cobs[startIndex])) {
        startIndex++; // Advance start to the first real number
      }
      if (startIndex < cobs.length) {
        stopIndex = startIndex + 1;
        while (stopIndex < cobs.length) {
          while (stopIndex < cobs.length && isNaN(cobs[stopIndex])) {
            stopIndex++; // Advance stop to the first real number after start
          }
          if (stopIndex < cobs.length) {
            // Now we have real numbers at start and stop and NaNs in between
            // Compute the y=k*x+m = (y2-y1)/(x2-x1)*x+y1
            // Only interpolate on decreasing or steady, or on increasing if the gap is less than interpolationGap
            // if (stopIndex-startIndex<interpolationGap && (cobs[stopIndex] <= cobs[startIndex]*interpolationRatio || (stopIndex-startIndex<interpolationGap && cobs[startIndex]!==0))) {
            if (loopalyzer.canInterpolate(cobs, startIndex, stopIndex)) {
              k = (cobs[stopIndex] - cobs[startIndex]) / (stopIndex - startIndex);
              m = cobs[startIndex];
              for (var x = 0; x < (stopIndex - startIndex); x++) {
                cobs[x + startIndex] = k * x + m;
                if (cobs[x + startIndex] < 0) {
                  cobs[x + startIndex] = 0;
                }
              }
            }
            startIndex = stopIndex;
            stopIndex++;
          }
        }
      }
    } else {
      for (var dt = dayStart; dt < dayEnd; dt.add(5, 'minutes')) {
        var cob = client.plugins('cob').cobTotal(datastorage.treatments, datastorage.devicestatus, profile, dt.toDate()).cob;
        cobs.push(cob);
      }
    }
    if (laDebug) console.log('getCOBs ' + day, cobs);
    loopalyzer.addArrayToBins(bins, cobs);
  });
  return bins;
}

/* Fills NaN gaps with treatments if treatments are available and value at start is less than value at stop */
loopalyzer.fillNanWithTreatments = function(array, treatments) {
  treatments.forEach(function(treatment) {
    var dayStart = moment(treatment.date).startOf('day');
    var minutesAfterMidnight = moment(treatment.date).diff(dayStart, 'minutes');
    var index = Math.floor(minutesAfterMidnight / 5);
    if (isNaN(array[index])) {
      var start = index;
      var stop = index;

      // Now move left and right until we find real numbers, so not NaN
      while (start >= 0 && isNaN(array[start])) {
        start--;
      }
      while (stop < array.length && isNaN(array[stop])) {
        stop++;
      }
      // var gap = stop - start;
      // if (isNaN(array[start]) || isNaN(array[stop]) || gap > interpolationGap || (gap < interpolationGap && array[start]<array[stop])) {
      // if ( isNaN(array[start]) || isNaN(array[stop]) || (array[start] < array[stop] && (gap >= interpolationGap || array[start]==0)) ) {
      var interpolate = (isNaN(array[start]) || isNaN(array[stop]) ? true : loopalyzer.canInterpolate(array, start, stop));
      if (!interpolate) {
        array[index] = treatment.amount;
      }
    }
  })
}

/* Returns true if we can interpolate between this start and end */
loopalyzer.canInterpolate = function(array, start, stop) {
  var interpolate = false;
  if (array[stop] <= array[start] * interpolationRatio) {
    // Falling
    if (stop - start < fallingInterpolationGap) interpolate = true;
  } else {
    // Rising
    if (stop - start < risingInterpolationGap && array[start] !== 0) interpolate = true;
  }
  return interpolate;
}

/* Returns the carbs treatments array as [date, amount] */
loopalyzer.getCarbTreatments = function(datastorage, daysToShow) {
  var treatments = []; // Holds the treatments [date, amount]
  var startDate = moment(daysToShow[0]);
  var endDate = moment(daysToShow[daysToShow.length - 1]).add(1, 'days');

  datastorage.treatments.filter(function(treatment) { return treatment.carbs && treatment.carbs > 0 }).forEach(function(treatment) {
    if (moment(treatment.created_at).isBetween(startDate, endDate)) {
      treatments.push({ date: treatment.created_at, amount: treatment.carbs });
    }
  })
  if (laDebug) console.log('Carb treatments', treatments);
  return treatments;
}

/* Returns the insulin treatments array as [date, amount] */
loopalyzer.getInsulinTreatments = function(datastorage, daysToShow) {
  var treatments = []; // Holds the treatments [date, amount]
  var startDate = moment(daysToShow[0]);
  var endDate = moment(daysToShow[daysToShow.length - 1]).add(1, 'days');

  datastorage.treatments.filter(function(treatment) { return treatment.insulin && treatment.insulin > 0 }).forEach(function(treatment) {
    if (moment(treatment.created_at).isBetween(startDate, endDate)) {
      treatments.push({ date: treatment.created_at, amount: treatment.insulin });
    }
  })
  if (laDebug) console.log('Insulin treatments', treatments);
  return treatments;
}

// PREDICTIONS START
//
loopalyzer.getAllTreatmentTimestampsForADay = function(datastorage, day) {
  var timestamps = [];
  var dayStart = moment(day).startOf('day');
  var carbTreatments = loopalyzer.getCarbTreatments(datastorage, [day]);
  var insulinTreatments = loopalyzer.getInsulinTreatments(datastorage, [day]);
  carbTreatments.forEach(function(entry) { timestamps.push(entry.date) });
  insulinTreatments.forEach(function(entry) { timestamps.push(entry.date) });
  timestamps.sort(function(a, b) { return (a < b ? -1 : 1) });
  timestamps.splice(0, 0, dayStart.toDate()); // Insert a fake timestamp at midnight so we can show predictions during night
  return timestamps;
}

loopalyzer.getAllPredictionsForADay = function(datastorage, day) {
  var predictions = [];
  var dayStart = moment(day).startOf('day');
  for (var i = datastorage.devicestatus.length - 1; i >= 0; i--) {
    if (datastorage.devicestatus[i].loop && datastorage.devicestatus[i].loop.predicted) {
      var predicted = datastorage.devicestatus[i].loop.predicted;
      if (moment(predicted.startDate).isSame(dayStart, 'day'))
        predictions.push(datastorage.devicestatus[i].loop.predicted);
    } else if (datastorage.devicestatus[i].openaps && datastorage.devicestatus[i].openaps.suggested && datastorage.devicestatus[i].openaps.suggested.predBGs) {
      var entry = {};
      entry.startDate = datastorage.devicestatus[i].openaps.suggested.timestamp;
      // For OpenAPS/AndroidAPS we fall back from COB if present, to UAM, then IOB
      if (datastorage.devicestatus[i].openaps.suggested.predBGs.COB) {
        entry.values = datastorage.devicestatus[i].openaps.suggested.predBGs.COB;
      } else if (datastorage.devicestatus[i].openaps.suggested.predBGs.UAM) {
        entry.values = datastorage.devicestatus[i].openaps.suggested.predBGs.UAM;
      } else entry.values = datastorage.devicestatus[i].openaps.suggested.predBGs.IOB;
      predictions.push(entry);
    }
  }
  // Remove duplicates before we're done
  var p = [];
  predictions.forEach(function(prediction) {
    if (p.length === 0 || prediction.startDate !== p[p.length - 1].startDate)
      p.push(prediction);
  })
  return p;
}

/* Find the earliest new predicted instance that has a timestamp equal to or larger than timestamp */
/* (so if we have bolused or eaten we want to find the prediction that Loop has estimated just after that) */
/* Returns the index into the predictions array that is the predicted we are looking for */
loopalyzer.findPredicted = function(predictions, timestamp, offset) {
  var ts = moment(timestamp).add(offset, 'minutes');
  var predicted = null;
  if (offset && offset < 0) { // If offset is negative, start searching from first prediction going forward
    for (let i = 0; i < predictions.length; i++) {
      if (predictions[i] && predictions[i].startDate && moment(predictions[i].startDate) <= ts) {
        predicted = i;
      }
    }
  } else { // If offset is positive or zero, start searching from last prediction going backward
    for (let i = predictions.length - 1; i > 0; i--) {
      if (predictions[i] && predictions[i].startDate && moment(predictions[i].startDate) >= ts) {
        predicted = i;
      }
    }
  }
  return predicted;
}

loopalyzer.getPredictions = function(datastorage, daysToShow, client) {

  if (!datastorage.devicestatus)
    return [];

  var predictedOffset = 0;
  var truncatePredictions = true;

  // Fill the bins array with the timestamp, one per 5 minutes
  var bins = [];
  var date = moment();
  date.set({ 'hours': 0, 'minutes': 0, 'seconds': 0, 'milliseconds': 0 });
  for (var i = 0; i < 288; i++) {
    bins.push([date.toDate(), []]);
    date.add(5, 'minutes');
  }

  daysToShow.forEach(function(day) {
    var p = []; // Array with all prediction SGVs for this day, we'll fill this and then insert into the bins later
    for (var i = 0; i < 288; i++) p.push(NaN);
    var treatmentTimestamps = loopalyzer.getAllTreatmentTimestampsForADay(datastorage, day);
    var predictions = loopalyzer.getAllPredictionsForADay(datastorage, day);

    if (predictions.length > 0 && treatmentTimestamps.length > 0) {

      // Iterate over all treatments, find the predictions for each and add them to the entries array p, aligned on timestamp
      for (var treatmentsIndex = 0; treatmentsIndex < treatmentTimestamps.length; treatmentsIndex++) {
        var timestamp = treatmentTimestamps[treatmentsIndex];
        var predictedIndex = loopalyzer.findPredicted(predictions, timestamp, predictedOffset); // Find predictions offset before or after timestamp

        if (predictedIndex != null) {
          var entry = predictions[predictedIndex]; // Start entry
          var d = moment(entry.startDate);
          var end = moment(day).endOf('day'); // Default to stop and end of the day
          if (truncatePredictions) {
            if (predictedOffset >= 0) {
              // But if we are looking forward we want to stop at the next treatment
              if (treatmentsIndex < treatmentTimestamps.length - 1) {
                end = moment(treatmentTimestamps[treatmentsIndex + 1]);
              }
            } else {
              // And if we are looking backward then we want to stop at "this" treatment
              end = moment(treatmentTimestamps[treatmentsIndex]);
            }
          }
          for (var entryIndex in entry.values) {
            if (!d.isAfter(end)) {
              var dayStart = moment(d).startOf('day');
              var minutesAfterMidnight = moment(d).diff(dayStart, 'minutes');
              var index = Math.floor(minutesAfterMidnight / 5);
              p[index] = client.utils.scaleMgdl(entry.values[entryIndex]);
              d.add(5, 'minutes');
            }
          }
        }
      }
    }
    for (let i = 0; i < 288; i++) {
      bins[i][1].push(p[i]);
    }
  })
  return bins;
}
//
// PREDICTIONS ENDS

// VARIOUS UTILITY FUNCTIONS //

/* Create an empty bins array with date stamps for today */
loopalyzer.getEmptyBins = function() {
  var bins = [];
  var todayStart = moment().startOf('day');
  var todayEnd = moment().endOf('day');
  for (var dt = todayStart; dt < todayEnd; dt.add(5, 'minutes')) {
    bins.push([dt.toDate(), []]);
  }
  return bins;
}

/* Takes an array of 288 values and adds to the bins */
loopalyzer.addArrayToBins = function(bins, values) {
  if (bins && bins.length === 288 && values && values.length === 288) {
    values.forEach(function(value, index) {
      bins[index][1].push(value);
    });
  } else
    console.log('addArrayToBins - array must have 288 items', values);
}

/* Fill all NaNs in an array by interpolating between adjacent values */
loopalyzer.interpolateArray = function(values, allowNegative) {
  var startIndex = 0
    , stopIndex = 0
    , k = 0
    , m = 0;

  while (isNaN(values[startIndex])) {
    startIndex++; // Advance start to the first real number
  }
  stopIndex = startIndex + 1;
  while (stopIndex < values.length) {
    while (stopIndex < values.length && isNaN(values[stopIndex])) {
      stopIndex++; // Advance stop to the first real number after start
    }
    if (stopIndex < values.length) {
      // Now we have real numbers at start and stop and NaNs in between
      // Compute the y=k*x+m = (y2-y1)/(x2-x1)*x+y1
      // Only interpolate if decreasing or steady, newer on increasing
      if (values[stopIndex] <= values[startIndex]) {
        k = (values[stopIndex] - values[startIndex]) / (stopIndex - startIndex);
        m = values[startIndex];
      }
      for (var x = 0; x < (stopIndex - startIndex); x++) {
        values[x + startIndex] = k * x + m;
        if (!allowNegative && values[x + startIndex] < 0) {
          values[x + startIndex] = 0;
        }
      }
      startIndex = stopIndex;
      stopIndex++;
    }
  }
}

/* Compute min value in bins */
loopalyzer.min = function(xBins) {
  var min = xBins[0][1];
  for (var i = 0; i < xBins.length; i++) {
    if (isNaN(min) || min === null) min = xBins[i][1];
    if (!isNaN(xBins[i][1]) && xBins[i][1] < min) min = xBins[i][1];
  }
  return min;
}

/* Compute max value in bins */
loopalyzer.max = function(xBins) {
  var max = xBins[0][1];
  for (var i = 0; i < xBins.length; i++) {
    if (isNaN(max) || max === null) max = xBins[i][1];
    if (!isNaN(xBins[i][1]) && xBins[i][1] > max) max = xBins[i][1];
  }
  return max;
}

/* Compute avg value in bins */
loopalyzer.avg = function(xBins) {
  var out = [];
  xBins.forEach(function(entry) {
    var sum = 0;
    var count = 0;
    entry[1].forEach(function(value) {
      if (value && !isNaN(value)) {
        sum += value;
        count++;
      }
    })
    var avg = sum / count;
    out.push([entry[0], avg]);
  })
  return out;
}

// Timeshifts a bins array with subarrays for multiple days
loopalyzer.timeShiftBins = function(bins, timeShift) {
  if (bins && bins.length > 0) {
    timeShift.forEach(function(minutes, dayIndex) {
      if (minutes !== 0) {
        var tempBin = [];
        bins.forEach(function() {
          tempBin.push(NaN); // Fill tempBin with NaNs
        })
        var minutesBy5 = Math.floor(minutes / 5);
        if (minutesBy5 > 0) {
          let count = 288 - minutesBy5;
          // If minutes>0 it means we should shift forward in time
          // Example: Shift by 15 mins = 3 buckets
          // bin    :  0   1   2  3 4 5 6 7 8 9 10
          // tempBin: NaN NaN NaN 0 1 2 3 4 5 6  7
          for (let i = 0; i < count; i++) {
            tempBin[i + minutesBy5] = bins[i][1][dayIndex];
          }
        }
        if (minutesBy5 < 0) {
          let count = 288 + minutesBy5;
          // If minutes<0 it means we should shift backward in time
          // Example: Shift by 15 mins = 3 buckets
          // bin    : 0 1 2 3 4 5 6  7  8   9   10
          // tempBin: 3 4 5 6 7 8 9 10 NaN NaN NaN 
          for (var i = 0; i < count; i++) {
            tempBin[i] = bins[i - minutesBy5][1][dayIndex];
          }
        }
        // Put the shifted data back into original bins variable (pass by pointer)
        for (let i = 0; i < 288; i++) {
          bins[i][1][dayIndex] = tempBin[i];
        }
      }
    });
  }
}

// Modifies the timestamp in the bin by timeShift minutes, for each day
loopalyzer.timeShiftSingleBin = function(bin, daysToShow, timeShift) {
  if (bin && bin.length > 0) {
    daysToShow.forEach(function(day, dayIndex) {
      var minutesToAdd = timeShift[dayIndex];
      var date = moment(day);
      bin.forEach(function(entry, entryIndex) {
        var entryDate = moment(entry.date);
        if (entryDate.isSame(date, 'day')) {
          entryDate.add(minutesToAdd, 'minutes');
          bin[entryIndex].date = entryDate.toDate();
        }
      })
    })
  }
}

/* Returns true if the profile values in a is identical to values in b, false otherwise */
loopalyzer.isSameProfileValues = function(a, b) {
  // Because the order of the keys are random when stringifying we do our own custom stringify ourselves
  var aString = '';
  var bString = '';
  if (a.basal) {
    aString += 'basal:';
    a.basal.forEach(function(entry) {
      aString += 's' + entry.timeAsSeconds + 't' + entry.time + 'v' + entry.value;
    })
  }
  if (a.carbratio) {
    aString += 'carbratio:';
    a.carbratio.forEach(function(entry) {
      aString += 's' + entry.timeAsSeconds + 't' + entry.time + 'v' + entry.value;
    })
  }
  if (a.sens) {
    aString += 'sens:';
    a.sens.forEach(function(entry) {
      aString += 's' + entry.timeAsSeconds + 't' + entry.time + 'v' + entry.value;
    })
  }
  if (b.basal) {
    bString += 'basal:';
    b.basal.forEach(function(entry) {
      bString += 's' + entry.timeAsSeconds + 't' + entry.time + 'v' + entry.value;
    })
  }
  if (b.carbratio) {
    bString += 'carbratio:';
    b.carbratio.forEach(function(entry) {
      bString += 's' + entry.timeAsSeconds + 't' + entry.time + 'v' + entry.value;
    })
  }
  if (b.sens) {
    bString += 'sens:';
    b.sens.forEach(function(entry) {
      bString += 's' + entry.timeAsSeconds + 't' + entry.time + 'v' + entry.value;
    })
  }
  return (aString == bString);
}

loopalyzer.renderProfilesTable = function(datastoreProfiles, daysToShow, client) {

  // Loop thru the daysToShow and get the timestamp of the first day displayed
  var beginningOfFirstDay = null;
  var endOfLastDay = null;
  daysToShow.forEach(function(day) {
    var dayStart = moment(day).startOf('day');
    var dayEnd = moment(day).endOf('day');
    if (!beginningOfFirstDay || dayStart < beginningOfFirstDay)
      beginningOfFirstDay = dayStart;
    if (!endOfLastDay || dayEnd > endOfLastDay)
      endOfLastDay = dayEnd;
  });

  // Now some profile juggling... We want to display only the profiles relevant to the days we are showing.
  // This includes the last profile created before the first display date, and the profiles created on the display dates.
  // However we don't want to show duplicate profiles and we also don't want to show more than just a few if there are many.

  // First, extract the profiles that have a startDate less than the endOfLastDay as only these are relevant, and sort
  // these on ascending startDate (create a clone array so we don't modify the Store array). And only save the profiles
  // that have basal, carbratio, or sens.
  var profilesArray1 = [];
  datastoreProfiles.forEach(function(entry) {
    var newEntry = {};
    newEntry.startDate = entry.startDate;
    var store = entry.store;
    if (store) {
      for (var key in store) {
        if (laDebug) console.log('profile ' + key);
        if (Object.prototype.hasOwnProperty.call(store, key)) {
          var defaultProfile = store[key];
          newEntry.profileName = key;
          if (defaultProfile.basal) newEntry.basal = defaultProfile.basal;
          if (defaultProfile.carbratio) newEntry.carbratio = defaultProfile.carbratio;
          if (defaultProfile.sens) newEntry.sens = defaultProfile.sens;
          if ((newEntry.basal || newEntry.carbratio || newEntry.sens) && moment(entry.startDate).isBefore(endOfLastDay))
            profilesArray1.push(newEntry);
        }
      }
    }
  })
  profilesArray1.sort(function(a, b) { return (a.startDate > b.startDate ? 1 : -1) }); // Ascending
  if (laDebug) {
    profilesArray1.forEach(function(entry) {
      console.log('profilesArray1 - ' + entry.startDate);
    })
  }
  if (laDebug) console.log('profilesArray1 has ' + profilesArray1.length + ' profiles');

  // Second, the deduplication - remove all duplicates which have a later startDate but identical data
  var profilesArray2 = [];
  var profileToCompareWith = profilesArray1[0];
  profilesArray2.push(profileToCompareWith); // Push the first profile, which should always be included.
  profilesArray1.forEach(function(entry) {
    if (laDebug) {
      console.log('Comparing ' + JSON.stringify(profileToCompareWith.startDate) + ' to ' + JSON.stringify(entry.startDate));
      console.log(profileToCompareWith, entry);
    }
    if (!loopalyzer.isSameProfileValues(profileToCompareWith, entry)) {
      profilesArray2.push(entry);
      profileToCompareWith = entry;
      if (laDebug)
        console.log('ADDING IT');
    } else {
      // Do NOT push the entry to profilesArray2, and keep comparing with the same (olders unique) profile
      if (laDebug)
        console.log('SKIPPING IT');
    }
  })
  if (laDebug) console.log('profilesArray2 has ' + profilesArray2.length + ' profiles');

  // Sort the newest Profile first
  profilesArray2.sort(function(a, b) { return (a.startDate > b.startDate ? 1 : -1) }); // Ascending

  // Third, find the latest profile with a startDate before beginningOfFirstDay
  var latestProfile = profilesArray2[0]; // This is the oldest one
  profilesArray2.forEach(function(entry) {
    if (laDebug)
      console.log(entry.startDate + ' isBefore ' + beginningOfFirstDay + ' = ' + moment(entry.startDate).isBefore(beginningOfFirstDay));
    if (moment(entry.startDate).isBefore(beginningOfFirstDay))
      latestProfile = entry;
  });
  if (laDebug) console.log('latest profile is ' + latestProfile.startDate);

  // Now create a final array with the latest profile found above and add all 
  // the other profiles with a startDate between beginningOfFirstDay and endOfLastDay
  var profiles = [];
  profiles.push(latestProfile); // Add the latest one
  profilesArray2.forEach(function(entry) {
    if (laDebug)
      console.log(entry.startDate + ' isAfter ' + beginningOfFirstDay + ' = ' + moment(entry.startDate).isAfter(beginningOfFirstDay));
    if (moment(entry.startDate).isAfter(beginningOfFirstDay))
      profiles.push(entry); // Add the profile if it's between beginning and end of show dates
  });

  // Now we have an array of all the profiles that are relevant for the days we are displaying.
  if (laDebug) {
    profiles.forEach(function(entry) {
      console.log('profiles - ' + entry.startDate);
    })
  }
  if (laDebug) console.log('profiles has ' + profiles.length + ' profiles');

  var translate = client.translate;
  var tableHtml = '<table id="loopalyzer-profiles-table"><tbody><tr>';

  profiles.forEach(function(theProfile, index) {

    if (index < 3) {
      tableHtml += '<td><table>';
      tableHtml += '<caption>' + theProfile.profileName + ' (' + new Date(theProfile.startDate).toLocaleString() + ')</caption>';
      tableHtml += '<thead><tr><th>' + translate('Basal') + '</th><th>' + translate('Carb ratio') + '</th><th>' + translate('Sensitivity') + '</th></tr></thead>';
      tableHtml += '<tbody><tr>';

      // Add Basal as a table in the first td
      tableHtml += '<td><table>';
      if (theProfile.basal) {
        theProfile.basal.forEach(function(entry) {
          tableHtml += '<tr><td>' + entry.time + '</td><td>' + parseFloat(entry.value).toFixed(3) + '</td></tr>'
        });
      }
      tableHtml += '</table></td>';

      // Add Carb Ratio as a table in the second td
      tableHtml += '<td><table>';
      if (theProfile.carbratio) {
        theProfile.carbratio.forEach(function(entry) {
          tableHtml += '<tr><td>' + entry.time + '</td><td>' + parseFloat(entry.value).toFixed(1) + '</td></tr>'
        });
      }
      tableHtml += '</table></td>';

      // Add Sensitivity as a table in the third td
      tableHtml += '<td><table>';
      if (theProfile.sens) {
        theProfile.sens.forEach(function(entry) {
          tableHtml += '<tr><td>' + entry.time + '</td><td>' + parseFloat(entry.value).toFixed(1) + '</td></tr>'
        });
      }
      tableHtml += '</table></td>';

      // Close theProfile table
      tableHtml += '</tr></tbody></table></td>';

    } else
    if (index == 3) {
      // Add ellipsis if too many profiles to display, but only one ellipsis even if there are more profiles
      tableHtml += '<td><table><caption>.....</caption></table></td>';
    }
  });

  // Close the entire table
  tableHtml += '</tr></tbody></table>';

  // And add our HTML to the view
  $("#loopalyzer-profiles").html(tableHtml);

};

// Main method
loopalyzer.report = function(datastorage, sorteddaystoshow, options) {
  if (laDebug) console.log('Loopalyzer ' + laVersion);

  // Copy the sorteddaystoshow into new array (clone) and re-sort ascending (so we don't mess with original array)
  var daysToShow = [];
  sorteddaystoshow.forEach(function(day) { daysToShow.push(day) });
  daysToShow.sort(function(a, b) { return (a < b ? -1 : 1) }); // We always want them chronological order

  var firstDay = moment(daysToShow[0]);
  var lastDay = moment(daysToShow[daysToShow.length - 1]);
  var days = lastDay.diff(firstDay, 'day') + 1;
  if (laDebug) console.log('Loopalyzer ' + firstDay.format() + ' - ' + lastDay.format() + ' is ' + days + ' days');
  if (days <= 14) {
    $("#loopalyzer-notenoughdata").hide();
    $("#loopalyzer-dateinfo").show();
    $("#loopalyzer-buttons").show();
    $("#loopalyzer-charts").show();
    $("#loopalyzer-profiles-table").show();
    $("#loopalyzer-help").hide();
    loopalyzer.generateReport(datastorage, daysToShow, options);
  } else {
    $("#loopalyzer-notenoughdata").show();
    $("#loopalyzer-dateinfo").hide();
    $("#loopalyzer-buttons").hide();
    $("#loopalyzer-charts").hide();
    $("#loopalyzer-profiles-table").hide();
    $("#loopalyzer-help").hide();
  }
}

loopalyzer.generateReport = function(datastorage, daysToShow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var profile = client.sbx.data.profile;
  // var report_plugins = Nightscout.report_plugins;
  // var scaledTreatmentBG = report_plugins.utils.scaledTreatmentBG;

  var today = new Date();
  var todayJSON = { 'year': today.getFullYear(), 'month': today.getMonth(), 'date': today.getDate() };

  var dateInfo = moment(daysToShow[0]).format('ddd MMM D'); // .split(',')[0];
  if (daysToShow.length > 1) dateInfo += ' - ' + moment(daysToShow[daysToShow.length - 1]).format('ddd MMM D'); // .split(',')[0];
  $("#loopalyzer-dateinfo").html(dateInfo);

  loopalyzer.prepareHtml();
  $("#loopalyzer-buttons").show();
  if (daysToShow.length == 1) {
    // Disable and gray out timeShift if only a single day
    $("#rp_loopalyzertimeshift").prop('checked', false);
    $("#rp_loopalyzertimeshift").attr("disabled", true);
    $("#rp_loopalyzermincarbs").attr("disabled", true);
    $("#rp_loopalyzert1").attr("disabled", true);
    $("#rp_loopalyzert2").attr("disabled", true);
    $("#rp_loopalyzertimeshiftinput").css('color', 'gray');
  } else {
    // Enable and turn the timeShift black if multiple days
    $("#rp_loopalyzertimeshift").removeAttr("disabled");
    $("#rp_loopalyzermincarbs").removeAttr("disabled");
    $("#rp_loopalyzert1").removeAttr("disabled");
    $("#rp_loopalyzert2").removeAttr("disabled");
    $("#rp_loopalyzertimeshiftinput").css('color', 'black');
  }
  // Check if there is data in the profiles and render the profiles table if there is
  if ($("#rp_loopalyzerprofiles").is(":checked") && (datastorage.profiles && datastorage.profiles.length > 0)) {
    $("#loopalyzer-profiles-table").show();
    loopalyzer.renderProfilesTable(datastorage.profiles, daysToShow, client);
  } else
    $("#loopalyzer-profiles-table").hide();

  // Pull all necessary treatment information
  profile.updateTreatments(datastorage.profileSwitchTreatments, datastorage.tempbasalTreatments, datastorage.combobolusTreatments);

  var carbTreatments = loopalyzer.getCarbTreatments(datastorage, daysToShow);
  var insulinTreatments = loopalyzer.getInsulinTreatments(datastorage, daysToShow);
  var sgvBin = loopalyzer.getSGVs(datastorage, daysToShow);
  var basalsBin = loopalyzer.getBasals(datastorage, daysToShow, profile);
  var tempBasalsBin = loopalyzer.getTempBasalDeltas(datastorage, daysToShow, profile);
  var iobBin = loopalyzer.getIOBs(datastorage, daysToShow, profile, client, insulinTreatments);
  var cobBin = loopalyzer.getCOBs(datastorage, daysToShow, profile, client, carbTreatments);
  var predictionsBin = [];

  if ($("#rp_loopalyzerpredictions").is(":checked")) {
    predictionsBin = loopalyzer.getPredictions(datastorage, daysToShow, client);
  }

  // Prepare an array with the minutes to timeShift each day (0 as default since timeShift is off by default)
  var timeShifts = [];
  var firstCarbs = [];
  var timeShiftStartTime = null; // If timeShifting this is the average time the meals were eaten
  var timeShiftStopTime = null; // and this is the start + DIA according to profile
  var doTimeShift = false;
  daysToShow.forEach(function() { timeShifts.push(0);
    firstCarbs.push(NaN) });

  // Check to see if we are doing timeShift or not
  if ($("#rp_loopalyzertimeshift").is(":checked") && daysToShow.length > 1) {
    var mealMinCarbs = $("#rp_loopalyzermincarbs").val();
    var t1 = $("#rp_loopalyzert1").val();
    var t2 = $("#rp_loopalyzert2").val();

    if (t2 > t1) {
      var h1 = t1.split(':')[0];
      var m1 = t1.split(':')[1];
      var h2 = t2.split(':')[0];
      var m2 = t2.split(':')[1];

      var timeShiftBegin = moment();
      timeShiftBegin.set({ 'hours': h1, 'minutes': m1, 'seconds': 0 });

      var timeShiftEnd = moment();
      timeShiftEnd.set({ 'hours': h2, 'minutes': m2, 'seconds': 0 });

      //Loop through the carb treatments and find the first meal each day
      daysToShow.forEach(function(day, dayIndex) {
        var timeShiftBegin = moment(day);
        var timeShiftEnd = moment(day);
        timeShiftBegin.set({ 'hours': h1, 'minutes': m1, 'seconds': 0 });
        timeShiftEnd.set({ 'hours': h2, 'minutes': m2, 'seconds': 0 });

        var found = false;
        carbTreatments.forEach(function(entry) {
          if (!found && entry.amount >= mealMinCarbs) {
            var date = moment(entry.date);
            if ((date.isSame(timeShiftBegin, 'minute') || date.isAfter(timeShiftBegin, 'minute')) &&
              (date.isSame(timeShiftEnd, 'minute') || date.isBefore(timeShiftEnd, 'minute'))) {
              var startOfDay = moment(entry.date);
              startOfDay.set({ 'hours': 0, 'minutes': 0, 'seconds': 0 });
              var minutesAfterMidnight = date.diff(startOfDay, 'minutes');
              firstCarbs[dayIndex] = minutesAfterMidnight;
              found = true;
              doTimeShift = true;
            }
          }
        })
      })

      // Calculate the average starting time, in minutes after midnight
      var sum = 0
        , count = 0;

      firstCarbs.forEach(function(minutesAfterMidnight) {
        if (minutesAfterMidnight) { // Avoid NaN
          sum += minutesAfterMidnight;
          count++;
        }
      });
      
      var averageMinutesAfterMidnight = Math.round(sum / count);

      var dia = profile.getDIA();
      if (!dia || dia <= 0)
        dia = 6; // Default to 6h if DIA not set in profile
      timeShiftStartTime = moment(todayJSON);
      timeShiftStartTime.minutes(averageMinutesAfterMidnight);
      timeShiftStopTime = moment(todayJSON);
      if (averageMinutesAfterMidnight + dia * 60 < 24 * 60)
        timeShiftStopTime.minutes(averageMinutesAfterMidnight + dia * 60); // If not beyond midnight, stop at end of DIA
      else
        timeShiftStopTime.minutes(24 * 60 - 1); // If beyond midnight, stop at midnight

      // Compute the timeShift (+ / -) that we should add to each entry (sgv, iob, carbs, etc) for each day
      firstCarbs.forEach(function(minutesAfterMidnight, index) {
        if (minutesAfterMidnight) { // Avoid NaN
          var delta = Math.round(averageMinutesAfterMidnight - minutesAfterMidnight);
          timeShifts[index] = delta;
        }
      });

      if (doTimeShift) {
        loopalyzer.timeShiftBins(sgvBin, timeShifts);
        loopalyzer.timeShiftBins(basalsBin, timeShifts);
        loopalyzer.timeShiftBins(tempBasalsBin, timeShifts);
        loopalyzer.timeShiftBins(iobBin, timeShifts);
        loopalyzer.timeShiftBins(cobBin, timeShifts);
        loopalyzer.timeShiftBins(predictionsBin, timeShifts);
        loopalyzer.timeShiftSingleBin(carbTreatments, daysToShow, timeShifts);
        loopalyzer.timeShiftSingleBin(insulinTreatments, daysToShow, timeShifts);
      }
    } else {
      console.log('Loopalyzer - Timeshift end must be later than beginning.');
    }
  }

  // After timeShift code block, get the average values
  var sgvAvg = loopalyzer.avg(sgvBin);
  var basalsAvg = loopalyzer.avg(basalsBin);
  var tempBasalsAvg = loopalyzer.avg(tempBasalsBin);
  var iobAvg = loopalyzer.avg(iobBin);
  var cobAvg = loopalyzer.avg(cobBin);
  var predictionsAvg = loopalyzer.avg(predictionsBin);

  var high = options.targetHigh;
  var low = options.targetLow;

  // Set up the charts basics
  function tickFormatter (val, axis) {
    if (val <= axis.min) { return ''; }
    if (val >= axis.max) { return ''; }
    return val + '';
  }

  var tickColor = '#DDDDDD';
  var basalColor = '#33A0FF';
  var glucoseColor = '#33AA33';
  var predictionsColor = '#8E1578';
  var glucoseRangeColor = '#D6FFD6';
  var insulinColor = '#FF7000';
  var carbColor = '#23D820';
  var timeShiftBackgroundColor = "#F3F3F3";
  var barWidth = (24 * 60 * 60 * 1000 / 288);
  var borderWidth = 1;
  var labelWidth = 25;
  var xaxisCfg = {
    mode: 'time'
    , timezone: 'browser'
    , timeformat: '%H:%M'
    , tickColor: tickColor
    , tickSize: [1, "hour"]
    , font: { size: 0 }
  };

  var hiddenAxis = {
    position: "right"
    , show: true
    , labelWidth: 10
    , tickColor: "#FFFFFF"
    , font: { size: 0 }
  }

  // For drawing the carbs and insulin treatments
  var markings = [];
  var markingColor = "#000000";

  // Chart 1: Basal
  markings = [];
  if (doTimeShift)
    markings.push({ xaxis: { from: timeShiftStartTime.toDate(), to: timeShiftStopTime.toDate() }, color: timeShiftBackgroundColor });
  var chartBasalData = [{
    data: basalsAvg
    , label: translate('Basal profile')
    , id: 'basals'
    , color: basalColor
    , points: { show: false }
    , bars: { show: true, fill: true, barWidth: barWidth }
    , yaxis: 1
  }];
  var chartBasalOptions = {
    xaxis: xaxisCfg
    , yaxes: [{
        tickColor: tickColor
        , labelWidth: labelWidth
        , tickFormatter: function(val, axis) { return tickFormatter(val, axis); }
    }
    , hiddenAxis]
    , grid: {
      borderWidth: borderWidth
      , markings: markings
    }
  };
  $.plot('#loopalyzer-basal', chartBasalData, chartBasalOptions);

  // Chart 2: Blood glucose
  markings = [];
  if (doTimeShift)
    markings.push({ xaxis: { from: timeShiftStartTime.toDate(), to: timeShiftStopTime.toDate() }, color: timeShiftBackgroundColor });
  markings.push({ yaxis: { from: low, to: high }, color: glucoseRangeColor });

  var chartBGData = [{
    label: translate('Blood glucose')
    , data: sgvAvg
    , id: 'glucose'
    , color: glucoseColor
    , points: { show: false }
    , lines: { show: true }
  }];
  if (predictionsAvg && predictionsAvg.length > 0) {
    chartBGData.push({
      label: translate('Predictions')
      , data: predictionsAvg
      , id: 'predictions'
      , color: predictionsColor
      , points: { show: true, fill: true, radius: 0.75, fillColor: predictionsColor }
      , lines: { show: false }
    });
  }
  var chartBGOptions = {
    xaxis: xaxisCfg
    , yaxes: [{
        min: 0
        , max: options.units === 'mmol' ? 20 : 400
        , tickColor: tickColor
        , labelWidth: labelWidth
        , tickFormatter: function(val, axis) { return tickFormatter(val, axis); }
    }
    , hiddenAxis]
    , grid: {
      borderWidth: borderWidth
      , markings: markings
    }
  };
  $.plot('#loopalyzer-bg', chartBGData, chartBGOptions);

  // Chart 3: Delta temp basals
  markings = [];
  if (doTimeShift)
    markings.push({ xaxis: { from: timeShiftStartTime.toDate(), to: timeShiftStopTime.toDate() }, color: timeShiftBackgroundColor });
  markings.push({ yaxis: { from: 0, to: 0 }, color: insulinColor, lineWidth: 2 });

  var chartTempBasalData = [{
    data: tempBasalsAvg
    , label: translate('Temp basal delta')
    , id: 'tempBasals'
    , color: insulinColor
    , points: { show: false }
    , bars: { show: true, barWidth: barWidth }
  }];
  var chartTempBasalOptions = {
    xaxis: xaxisCfg
    , yaxes: [{
        tickColor: tickColor
        , labelWidth: labelWidth
        , tickFormatter: function(val, axis) { return tickFormatter(val, axis); }
    }
    , hiddenAxis]
    , grid: {
      borderWidth: borderWidth
      , markings: markings
    }
  };
  $.plot('#loopalyzer-tempbasal', chartTempBasalData, chartTempBasalOptions);

  // Chart 4: IOB
  markings = [];
  if (doTimeShift)
    markings.push({ xaxis: { from: timeShiftStartTime.toDate(), to: timeShiftStopTime.toDate() }, color: timeShiftBackgroundColor });
  insulinTreatments.forEach(function(treatment) {
    var startDate = moment(treatment.date);
    var endDate = moment(treatment.date);
    startDate.set(todayJSON);
    endDate.set(todayJSON);
    endDate.add(5, 'minutes');
    markings.push({ xaxis: { from: startDate.toDate(), to: endDate.toDate() }, yaxis: { from: 0, to: treatment.amount }, color: markingColor });
  })

  var chartIOBData = [{
    data: iobAvg
    , label: translate('IOB')
    , id: 'iobs'
    , color: insulinColor
    , points: { show: false }
    , bars: { show: true, fill: true, barWidth: barWidth }
  }];
  var chartIOBOptions = {
    xaxis: xaxisCfg
    , yaxes: [{
        tickColor: tickColor
        , labelWidth: labelWidth
        , tickFormatter: function(val, axis) { return tickFormatter(val, axis); }
    }
    , hiddenAxis]
    , grid: {
      borderWidth: borderWidth
      , markings: markings
    }
  };
  $.plot('#loopalyzer-iob', chartIOBData, chartIOBOptions);

  // Chart 5: COB
  markings = [];
  if (doTimeShift)
    markings.push({ xaxis: { from: timeShiftStartTime.toDate(), to: timeShiftStopTime.toDate() }, color: timeShiftBackgroundColor });
  carbTreatments.forEach(function(treatment) {
    var startDate = moment(treatment.date);
    var endDate = moment(treatment.date);
    startDate.set(todayJSON);
    endDate.set(todayJSON);
    endDate.add(5, 'minutes');
    markings.push({ xaxis: { from: startDate.toDate(), to: endDate.toDate() }, yaxis: { from: 0, to: treatment.amount }, color: markingColor });
  })
  delete xaxisCfg.font; // Remove the font config so HH:MM is shown on the last chart

  var chartCOBData = [{
    data: cobAvg
    , label: translate('COB')
    , id: 'cobs'
    , color: carbColor
    , points: { show: false }
    , bars: { show: true, fil: true, barWidth: barWidth }
  }];
  var chartCOBOptions = {
    xaxis: xaxisCfg
    , yaxes: [{
        tickColor: tickColor
        , labelWidth: labelWidth
        , tickFormatter: function(val, axis) { return tickFormatter(val, axis); }
    }
    , hiddenAxis]
    , grid: {
      borderWidth: borderWidth
      , markings: markings
    }
  };
  $.plot('#loopalyzer-cob', chartCOBData, chartCOBOptions);

};
