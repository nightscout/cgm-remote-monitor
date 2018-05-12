'use strict';

var _ = require('lodash');
var moment = window.moment;
var times = require('../times');
var d3 = (global && global.d3) || require('d3');

var loopalyzer = {
  name: 'loopalyzer'
  , label: 'Loopalyzer'
  , pluginType: 'report'
};

function init() {
  return loopalyzer;
}

module.exports = init;

var minutewindow = 5; //minute-window should be a divisor of 60

loopalyzer.html = function html(client) {
  var translate = client.translate;
  var ret = ''
    ret += '<h2>' + translate('Loopalyzer') + '</h2>'
    ret += '<span id="loopalyzer-help"><b>' + translate('To see this report, press SHOW while in this view') + '</b></span>'
    ret += '<div id="loopalyzer-buttons" style="display:none;">'
    ret += '<input type="checkbox" id="rp_loopalyzertreatments" checked>'+translate('Show bolus &amp; carb treatments')+'&nbsp;&nbsp;&nbsp;&nbsp;'
    ret += '<span id="rp_loopalyzertimeshiftinput" style="display:none;">' /* So we can show only if viewing multiple days */
    ret += '<input type="checkbox" id="rp_loopalyzertimeshift">'
    ret += translate('Timeshift meals larger than') + ' '
    ret += '<input type="number" style="width: 3.5em" value="10" id="rp_loopalyzermincarbs">'+' '+translate('g carbs')
    ret += '&nbsp;'+translate('consumed between')
    ret += ' <select id="rp_loopalyzert1">';
    for (var i=0; i<24; i++) {
      var H=(i<10?'0':'') + i;
      ret += '  <option t1="' + H + ':00"' + (i==6?' selected':'') +'>' + H + ':00</option>'
      ret += '  <option t1="' + H + ':30">' + H + ':30</option>'
    };
    ret += '</select>'
    ret += '  '+translate('and')
    ret += ' <select id="rp_loopalyzert2">'
    for (var i=0; i<24; i++) {
      var H=(i<10?'0':'') + i;
      ret += '  <option t2="' + H + ':00"' + (i==9?' selected':'') +'>' + H + ':00</option>'
      ret += '  <option t2="' + H + ':30">' + H + ':30</option>'
    };
    ret += '</select>'
    ret += '</span>' /* timeShift */
    ret += '<br/><br/>'
    ret += '<input type="button" onclick="loopalyzerMoreBackward();" value="&lt;&lt;&lt;&nbsp;' + translate('Backward')+'">'
    ret += '<input type="button" onclick="loopalyzerBackward();" value="&lt;&nbsp;' + translate('Backward')+'">'
    ret += '<input type="button" onclick="loopalyzerForward();" value="' + translate('Forward')+'&nbsp;&gt;">'
    ret += '<input type="button" onclick="loopalyzerMoreForward();" value="' + translate('Forward')+'&nbsp;&gt;&gt;&gt;">'
    ret += '</div>'
    ret += '<div id="loopalyzer-charts" style="padding:20px;">'
    ret += '  <div class="chart" id="loopalyzer-basal" style="height:100px;margin-bottom:-14px;"></div>'
    ret += '  <div class="chart" id="loopalyzer-bg" style="height:200px;margin-bottom:-14px;"></div>'
    ret += '  <div class="chart" id="loopalyzer-tempbasal" style="height:150px;margin-bottom:-14px;"></div>'
    ret += '  <div class="chart" id="loopalyzer-iob" style="height:150px;margin-bottom:-14px;"></div>'
    ret += '  <div class="chart" id="loopalyzer-cob" style="height:150px;"></div>'
    ret += '</div>'
    ret += '<div id="loopalyzer-carbTreatmentsTable"></div>'
    ret += '<div id="loopalyzer-insulinTreatmentsTable"></div>'
    ;
    return ret;
};

loopalyzer.css =
    '#loopalyzer-basal, #loopalyzer-bg, #loopalyzer-tempbasal, #loopalyzer-iob, #loopalyzer-cob {'
  + '  width: 100%;'
  + '  height: 100%;'
  + '}'
  ;

loopalyzer.prepareHtml = function loopalyzerPrepareHtml() {
//  $('#loopalyzer-carbTreatmentsTable').html('');
//  $('#loopalyzer-insulinTreatmentsTable').html('');
//  $('#loopalyzer-charts').append($('<table><tr><td><div id="loopalyzerchart"></div></td><td><div id="loopalyzerstatchart"></td></tr></table>'));
};

loopalyzer.ss = require('simple-statistics');

loopalyzer.getSGVs = function(datastorage, daysToShow) {
  var data = datastorage.allstatsrecords;
  var bins = [];

  var filterFunc = function withinWindow(record) {
    var recdate = new Date(record.displayTime);
    return recdate.getHours() === hour && recdate.getMinutes() >= minute && recdate.getMinutes() < minute + minutewindow;
  };
  
  // Loop through all hours & minutes and days and get the readings
  for (var hour = 0; hour < 24; hour++) {
    for (var minute = 0; minute < 60; minute = minute + minutewindow) {
      var date = new Date();
      date.setHours(hour);
      date.setMinutes(minute);
      date.setSeconds(0);
      date.setMilliseconds(0);
      var readings = data.filter(filterFunc);
      readings = readings.map(function(record) {
        return record.sgv;
      });
      bins.push([date, readings]);
    }
  }
  return bins;
}


loopalyzer.getBasals = function(datastorage, daysToShow, profile) {
  var bins = [];

  // Loop through all hours & minutes and days and get the basal from profile
  for (var hour = 0; hour < 24; hour++) {
    for (var minute = 0; minute < 60; minute = minute + minutewindow) {
      var basalValues = [];
      for (var m = 0; m < minutewindow; m = m + 5) {
        daysToShow.forEach(function(d, dayIndex){
          var date = new Date(d);
          date.setHours(hour);
          date.setMinutes(minute + m);
          date.setSeconds(0);
          date.setMilliseconds(0);
          var basalValue = profile.getTempBasal(date);
          basalValues.push(basalValue.basal);
        });
      }
      var date = new Date();
      date.setHours(hour);
      date.setMinutes(minute);
      date.setSeconds(0);
      date.setMilliseconds(0);
      bins.push([date, basalValues]);
    }
  }
  return bins;
}

loopalyzer.getTempBasalDeltas = function(datastorage, daysToShow, profile) {
  var bins = [];

  // Loop through all hours & minutes and days and get the basal from profile, 
  // and compute the plus/minus delta temp basal and push to bins
  for (var hour = 0; hour < 24; hour++) {
    for (var minute = 0; minute < 60; minute = minute + minutewindow) {
      var basalValues = [];
      for (var m = 0; m < minutewindow; m = m + 5) {
        daysToShow.forEach(function(d, dayIndex){
          var date = new Date(d);
          date.setHours(hour);
          date.setMinutes(minute + m);
          date.setSeconds(0);
          date.setMilliseconds(0);
          var basalValue = profile.getTempBasal(date);
          basalValues.push(basalValue.tempbasal - basalValue.basal);
        });
      }
      var date = new Date();
      date.setHours(hour);
      date.setMinutes(minute);
      date.setSeconds(0);
      date.setMilliseconds(0);
      bins.push([date, basalValues]);
    }
  }
  return bins;
}


loopalyzer.getIOBs = function(datastorage, daysToShow) {

  // Create a single array of empty IOB entries to hold all IOBs for all days, one entry per 5 minutes
  var iobs=[];
  var numberOfEntries = 288 * daysToShow.length;
  for (var i=0; i<numberOfEntries; i++) iobs.push(NaN); // Clear the IOBs by filling with NaNs

  // Loop through all days to show, and for each day extract the IOBs and add to the long IOBs array
  daysToShow.forEach(function(day, dayIndex) {
    var dayStart = moment(day); // Create something so we can compute delta number of minutes later

    // Extract all devicestatus that has IOB for this day and sort ascending timestamp
    var devicestatus = datastorage[day].devicestatus.filter(function(entry){ return entry.loop && entry.loop.iob});
    devicestatus.forEach(function(entry) {
      var minutesAfterMidnight = moment(entry.loop.iob.timestamp).diff(dayStart, 'minutes');
      var index = dayIndex * 288 + Math.floor(minutesAfterMidnight/5);
      iobs[index] = entry.loop.iob.iob; // Any index that has real data is updated, rest remain at NaN
    })
  });

  // Loop thru these entries and where no IOB has been found, interpolate between nearby to get a continuous array
  var startIndex = 0, stopIndex = 0;
  while (isNaN(iobs[startIndex])) {
    startIndex++; // Advance start to the first real number
  }
  stopIndex = startIndex+1;
  while (stopIndex<iobs.length) {
    while (stopIndex<iobs.length && isNaN(iobs[stopIndex])) {
      stopIndex++; // Advance stop to the first real number after start
    }
    if (stopIndex<iobs.length) {
      // Now we have real numbers at start and stop and NaNs in between
      // Compute the y=k*x+m = (y2-y1)/(x2-x1)*x+y1
      var k = (iobs[stopIndex] - iobs[startIndex]) / (stopIndex-startIndex);
      var m = iobs[startIndex];
      for (var x=0; x<(stopIndex-startIndex); x++) {
        iobs[x + startIndex] = k*x+m;
      }
      startIndex = stopIndex;
      stopIndex++;
    }
  }

  // Now loop thru all IOBs and add them with a date/timestamp and array of values for the days into the bins
  var bins = [];
  for (var i=0; i<288; i++) {
    var values = [];
    for (var d = 0; d<daysToShow.length; d++) {
      values.push(iobs[d*288 + i]);
    }
    var date = new Date();
    var minutesAfterMidnight = i*5;
    date.setHours(Math.floor(minutesAfterMidnight/60));
    date.setMinutes(minutesAfterMidnight % 60);
    date.setSeconds(0);
    date.setMilliseconds(0);
    bins.push([date, values]);
  }
  return bins;
};

loopalyzer.getCOBs = function(datastorage, daysToShow) {
 
  // Create a single array of empty COB entries to hold all COBs for all days, one entry per 5 minutes
  var cobs=[];
  var numberOfEntries = 288 * daysToShow.length;
  for (var i=0; i<numberOfEntries; i++) cobs.push(NaN); // Clear the COBs by filling with NaNs

  // Loop through all days to show, and for each day extract the COBs and add to the long COBs array
  daysToShow.forEach(function(day, dayIndex) {
    var dayStart = moment(day); // Create something so we can compute delta number of minutes later

    // Extract all devicestatus that has COB for this day and sort ascending timestamp
    var devicestatus = datastorage[day].devicestatus.filter(function(entry){return entry.loop && entry.loop.cob});
    devicestatus.forEach(function(entry) {
      var minutesAfterMidnight = moment(entry.loop.cob.timestamp).diff(dayStart, 'minutes');
      var index = dayIndex * 288 + Math.floor(minutesAfterMidnight/5);
      cobs[index] = entry.loop.cob.cob; // Any index that has real data is updated, rest remain at NaN
    })
  });

  // Loop thru these entries and where no COB has been found, interpolate between nearby to get a continuous array
  var startIndex=0, stopIndex=0, k=0, m=0;

  while (isNaN(cobs[startIndex])) {
    startIndex++; // Advance start to the first real number
  }
  stopIndex = startIndex+1;
  while (stopIndex<cobs.length) {
    while (stopIndex<cobs.length && isNaN(cobs[stopIndex])) {
      stopIndex++; // Advance stop to the first real number after start
    }
    if (stopIndex<cobs.length) {
      // Now we have real numbers at start and stop and NaNs in between
      // Compute the y=k*x+m = (y2-y1)/(x2-x1)*x+y1
      // Only interpolate if decreasing or steady, newer on increasing
      if (cobs[stopIndex] <= cobs[startIndex]) {
        k = (cobs[stopIndex] - cobs[startIndex]) / (stopIndex-startIndex);
        m = cobs[startIndex];
      }
      for (var x=0; x<(stopIndex-startIndex); x++) {
          cobs[x + startIndex] = k*x+m;
          if (cobs[x + startIndex] < 0) {
            cobs[x + startIndex]=0;
          }
      }
      startIndex = stopIndex;
      stopIndex++;
    }
  }

  // Now loop thru all COBs and add them with a date/timestamp and array of values for the days into the bins
  var bins = [];
  for (var i=0; i<288; i++) {
    var values = [];
    for (var d = 0; d<daysToShow.length; d++) {
      values.push(cobs[d*288 + i]);
    }
    var date = new Date();
    var minutesAfterMidnight = i*5;
    date.setHours(Math.floor(minutesAfterMidnight/60));
    date.setMinutes(minutesAfterMidnight % 60);
    date.setSeconds(0);
    date.setMilliseconds(0);
    bins.push([date, values]);
  }
  return bins;
};

/* Returns the carbs treatments array as [date, amount] */
loopalyzer.getCarbTreatments = function(datastorage, daysToShow) {
  var treatments = []; // Holds the treatments [date, amount]
  var startDate = moment(daysToShow[0]);
  var endDate = moment(daysToShow[daysToShow.length-1]).add(1, 'days');

  datastorage.treatments.filter(function(treatment){return treatment.carbs && treatment.carbs >0}).forEach(function(treatment){
    if (moment(treatment.created_at).isBetween(startDate, endDate)) {
      treatments.push({date:treatment.created_at, amount:treatment.carbs});
    }
  })
  return treatments;
}

/* Returns the insulin treatments array as [date, amount] */
loopalyzer.getInsulinTreatments = function(datastorage, daysToShow) {
  var treatments = []; // Holds the treatments [date, amount]
  var startDate = moment(daysToShow[0]);
  var endDate = moment(daysToShow[daysToShow.length-1]).add(1, 'days');

  datastorage.treatments.filter(function(treatment){return treatment.insulin && treatment.insulin >0}).forEach(function(treatment){
    if (moment(treatment.created_at).isBetween(startDate, endDate)) {
      treatments.push({date:treatment.created_at, amount:treatment.insulin});
    }
  })
  return treatments;
}

loopalyzer.min = function(xBins) {
  var min = xBins[0][1];
  for (var i=0; i<xBins.length; i++) {
    if (isNaN(min) || min === null) min = xBins[i][1];
    if (!isNaN(xBins[i][1]) && xBins[i][1]<min) min = xBins[i][1];
  }
  return min;
}

loopalyzer.max = function(xBins) {
  var max = xBins[0][1];
  for (var i=0; i<xBins.length; i++) {
    if (isNaN(max) || max === null) max = xBins[i][1];
    if (!isNaN(xBins[i][1]) && xBins[i][1]>max) max = xBins[i][1];
  }
  return max;
}

loopalyzer.avg = function(xBins) {
  var out=[];
  xBins.forEach(function(entry){
    var sum = 0;
    var count = 0;
    entry[1].forEach(function(value){
      if (value && value != NaN) {
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
  timeShift.forEach(function(minutes, dayIndex){
    if (minutes !==0) {
      var tempBin = [];
      bins.forEach(function(entry){
        tempBin.push(NaN); // Fill tempBin with NaNs
      })
      var minutesBy5 = Math.floor(minutes/5);
      if (minutesBy5>0) {
        var count = 288-minutesBy5;
        // If minutes>0 it means we should shift forward in time
        // Example: Shift by 15 mins = 3 buckets
        // bin    :  0   1   2  3 4 5 6 7 8 9 10
        // tempBin: NaN NaN NaN 0 1 2 3 4 5 6  7
        for (var i=0; i<count; i++) {
          tempBin[i+minutesBy5] = bins[i][1][dayIndex];
        }
      }
      if (minutesBy5<0) {
        var count = 288+minutesBy5;
        // If minutes<0 it means we should shift backward in time
        // Example: Shift by 15 mins = 3 buckets
        // bin    : 0 1 2 3 4 5 6  7  8   9   10
        // tempBin: 3 4 5 6 7 8 9 10 NaN NaN NaN 
        for (var i=0; i<count; i++) {
          tempBin[i] = bins[i-minutesBy5][1][dayIndex];
        }
      }
      // Put the shifted data back into original bins variable (pass by pointer)
      for (var i=0; i<288; i++) {
        bins[i][1][dayIndex] = tempBin[i];
      }
    }
  });
}

// Modifies the timestamp in the bin by timeShift minutes, for each day
loopalyzer.timeShiftSingleBin = function(bin, daysToShow, timeShift) {
  daysToShow.forEach(function(day, dayIndex){
    var minutesToAdd = timeShift[dayIndex];
    var date = moment(day);
    bin.forEach(function(entry, entryIndex){
      var entryDate = moment(entry.date);
      if (entryDate.isSame(date, 'day')) {
        entryDate.add(minutesToAdd, 'minutes');
        bin[entryIndex].date=entryDate.toDate();
      }
    })
  })
}

// Main method
loopalyzer.report = function report_loopalyzer(datastorage,sorteddaystoshow,options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var profile = client.sbx.data.profile;
  var report_plugins = Nightscout.report_plugins;
  var scaledTreatmentBG = report_plugins.utils.scaledTreatmentBG;

  // Copy the sorteddaystoshow into new array (clone) and re-sort ascending (so we don't mess with original array)
  var daysToShow = [];
  sorteddaystoshow.forEach(function(day){daysToShow.push(day)});
  daysToShow.sort(function(a,b){return a>b});
  
  loopalyzer.prepareHtml();
  $("#loopalyzer-help").hide();
  $("#loopalyzer-buttons").show();
  if (daysToShow.length==1)
    $("#rp_loopalyzertimeshiftinput").hide(); /* Hide timeShift if single day */
  else
    $("#rp_loopalyzertimeshiftinput").show(); /* and show if multi days */


  // Pull all necessary treatment information
  profile.updateTreatments(datastorage.profileSwitchTreatments, datastorage.tempbasalTreatments, datastorage.combobolusTreatments);

  var carbTreatments = loopalyzer.getCarbTreatments(datastorage,daysToShow);
  var insulinTreatments = loopalyzer.getInsulinTreatments(datastorage,daysToShow);
  var sgvBin = loopalyzer.getSGVs(datastorage,daysToShow);
  var basalsBin = loopalyzer.getBasals(datastorage,daysToShow,profile);
  var tempBasalsBin = loopalyzer.getTempBasalDeltas(datastorage,daysToShow,profile);
  var iobBin = loopalyzer.getIOBs(datastorage,daysToShow);
  var cobBin = loopalyzer.getCOBs(datastorage,daysToShow);

  // Prepare an array with the minutes to timeShift each day (0 as default since timeShift is off by default)
  var timeShifts = [];
  var firstCarbs = [];
  daysToShow.forEach(function(day){ timeShifts.push(0); firstCarbs.push(NaN) });

  // Check to see if we are doing timeShift or not
  if ($("#rp_loopalyzertimeshift").is(":checked") && daysToShow.length>1) {
    var mealMinCarbs = $("#rp_loopalyzermincarbs").val();
    var t1 = $("#rp_loopalyzert1").val();
    var t2 = $("#rp_loopalyzert2").val();

    var h1 = t1.split(':')[0];
    var m1 = t1.split(':')[1];
    var h2 = t2.split(':')[0];
    var m2 = t2.split(':')[1];
    
    var timeShiftBegin = moment();
    timeShiftBegin.set({'hours':h1, 'minutes':m1, 'seconds':0});

    var timeShiftEnd = moment();
    timeShiftEnd.set({'hours':h2, 'minutes':m2, 'seconds':0});
    
    //Loop through the carb treatments and find the first meal each day
    daysToShow.forEach(function(day, dayIndex){
      var timeShiftBegin = moment(day);
      var timeShiftEnd = moment(day);
      timeShiftBegin.set({'hours':h1, 'minutes':m1, 'seconds':0});
      timeShiftEnd.set({'hours':h2, 'minutes':m2, 'seconds':0});
  
      var found = false;
      carbTreatments.forEach(function(entry){
        if (!found && entry.amount >= mealMinCarbs) {
          var date = moment(entry.date);
          if ( (date.isSame(timeShiftBegin,'minute') || date.isAfter(timeShiftBegin,'minute')) &&
               (date.isSame(timeShiftEnd,'minute') || date.isBefore(timeShiftEnd,'minute')) ) {
                var startOfDay = moment(entry.date);
                startOfDay.set({'hours':0, 'minutes':0, 'seconds':0});
                var minutesAfterMidnight = date.diff(startOfDay, 'minutes');
                firstCarbs[dayIndex]=minutesAfterMidnight;
                found = true;
              }
        }
      })
    })

    // Calculate the average starting time, in minutes after midnight
    var averageMinutesAfterMidnight = 0, sum = 0, count = 0;
    firstCarbs.forEach(function(minutesAfterMidnight){
      if (minutesAfterMidnight) { // Avoid NaN
        sum += minutesAfterMidnight;
        count++;
      }
    });
    var averageMinutesAfterMidnight = Math.round(sum / count);

    // Compute the timeShift (+ / -) that we should add to each entry (sgv, iob, carbs, etc) for each day
    firstCarbs.forEach(function(minutesAfterMidnight,index){
      if (minutesAfterMidnight) { // Avoid NaN
        var delta = Math.round(averageMinutesAfterMidnight - minutesAfterMidnight);
        timeShifts[index]=delta;
      }
    });

    loopalyzer.timeShiftBins(sgvBin, timeShifts);
    loopalyzer.timeShiftBins(basalsBin, timeShifts);
    loopalyzer.timeShiftBins(tempBasalsBin, timeShifts);
    loopalyzer.timeShiftBins(iobBin, timeShifts);
    loopalyzer.timeShiftBins(cobBin, timeShifts);
    loopalyzer.timeShiftSingleBin(carbTreatments, daysToShow, timeShifts);
    loopalyzer.timeShiftSingleBin(insulinTreatments, daysToShow, timeShifts);
  }

  // After timeShift code block, get the average values
  var sgvAvg = loopalyzer.avg(sgvBin);
  var basalsAvg = loopalyzer.avg(basalsBin);
  var tempBasalsAvg = loopalyzer.avg(tempBasalsBin);
  var iobAvg = loopalyzer.avg(iobBin);
  var cobAvg = loopalyzer.avg(cobBin);

  var high = options.targetHigh;
  var low = options.targetLow;

  // Set up the charts basics
  function tickFormatter(val,axis) {
    if (val <= axis.min) { return ''; }
    if (val >= axis.max) { return ''; }
    return val + '';
  }

  var tickColor = '#DDDDDD';
  var basalColor = '#33A0FF';
  var glucoseColor = '#33AA33';
  var glucoseRangeColor = '#D6FFD6';
  var insulinColor = '#FF7000';
  var carbColor = '#23D820';
  var barWidth = (24 * 60 * 60 * 1000 / 288);
  var borderWidth = 1;
  var labelWidth = 25;
  var xaxisCfg = {
      mode: 'time',
      timezone: 'browser',
      timeformat: '%H:%M',
      tickColor: tickColor,
      tickSize: [1, "hour"],
      font: { size: 0 }
  };

  var hiddenAxis = {
    position: "right",
    show: true,
    labelWidth: 10,
    tickColor: "#FFFFFF",
    font: { size: 0}
  }

  // For drawing the carbs and insulin treatments
  var today = new Date();
  var todayJSON = {'year':today.getFullYear(), 'month':today.getMonth(), 'date':today.getDate()};
  var markings = [];
  var markingColor = "#000000";


  // Chart 1: Basal
  var chartBasalData = [{
    data: basalsAvg,
    label: translate('Basal profile'),
    id: 'basals',
    color: basalColor,
    points: { show: false },
    bars: { show: true, fill: true, barWidth: barWidth },
    yaxis: 1
  }];
  var chartBasalOptions = {
    xaxis: xaxisCfg,
    yaxes: [{
      tickColor: tickColor,
      labelWidth: labelWidth,
      tickFormatter: function(val,axis) { return tickFormatter(val,axis); }
    }, 
    hiddenAxis],
    grid: {
      borderWidth: borderWidth
    }
  };
  $.plot( '#loopalyzer-basal', chartBasalData, chartBasalOptions );


  // Chart 2: Blood glucose
  var chartBGData = [{
    label: translate('Blood glucose'),
    data: sgvAvg,
    id: 'glucose',
    color: glucoseColor,
    points: { show: false },
    lines: { show: true }
  }];
  var chartBGOptions = {
    xaxis: xaxisCfg,
    yaxes: [{
      min: 0,
      max: options.units === 'mmol' ? 20 : 400,
      tickColor: tickColor,
      labelWidth: labelWidth,
      tickFormatter: function(val,axis) { return tickFormatter(val,axis); }
    },
    hiddenAxis],
    grid: {
      borderWidth: borderWidth,
      markings: [{ 
        color: glucoseRangeColor,
        yaxis: { from: low, to: high }
      }]
    }
  };
  $.plot( '#loopalyzer-bg', chartBGData, chartBGOptions );
  

  // Chart 3: Delta temp basals
  var chartTempBasalData = [{
    data: tempBasalsAvg,
    label: translate('Temp basal delta'),
    id: 'tempBasals',
    color: insulinColor,
    points: { show: false },
    bars: { show: true, barWidth: barWidth }
  }];
  var chartTempBasalOptions = {
    xaxis: xaxisCfg,
    yaxes: [{
      tickColor: tickColor,
      labelWidth: labelWidth,
      tickFormatter: function(val,axis) { return tickFormatter(val,axis); }
    },
    hiddenAxis],
    grid: {
      borderWidth: borderWidth,
      markings: [{ 
        color: insulinColor,
        yaxis: { from: 0, to: 0 },
        lineWidth: 2
      }]
    }
  };
  $.plot( '#loopalyzer-tempbasal', chartTempBasalData, chartTempBasalOptions );


  // Chart 4: IOB
  if ($("#rp_loopalyzertreatments").is(":checked")) {
    markings = [];
    insulinTreatments.forEach(function(treatment){
      var startDate = moment(treatment.date);
      var endDate = moment(treatment.date);
      startDate.set(todayJSON);
      endDate.set(todayJSON);
      endDate.add(5, 'minutes');
      markings.push( { xaxis: { from: startDate.toDate(), to: endDate.toDate()}, yaxis: { from: 0, to: treatment.amount }, color: markingColor } );
    })
  }

  var chartIOBData = [{
    data: iobAvg,
    label: translate('IOB'),
    id: 'iobs',
    color: insulinColor,
    points: { show: false },
    bars: { show: true, fill: true, barWidth: barWidth }
  }];
  var chartIOBOptions = {
    xaxis: xaxisCfg,
    yaxes: [{
      tickColor: tickColor,
      labelWidth: labelWidth,
      tickFormatter: function(val,axis) { return tickFormatter(val,axis); }
    },
    hiddenAxis],
    grid: {
      borderWidth: borderWidth,
      markings: markings
    }
  };
  $.plot( '#loopalyzer-iob', chartIOBData, chartIOBOptions );


  // Chart 5: COB
  if ($("#rp_loopalyzertreatments").is(":checked")) {
    markings = [];
    carbTreatments.forEach(function(treatment){
      var startDate = moment(treatment.date);
      var endDate = moment(treatment.date);
      startDate.set(todayJSON);
      endDate.set(todayJSON);
      endDate.add(5, 'minutes');
      markings.push( { xaxis: { from: startDate.toDate(), to: endDate.toDate()}, yaxis: { from: 0, to: treatment.amount }, color: markingColor } );
    })
  }
  delete xaxisCfg.font; // Remove the font config so HH:MM is shown on the last chart

  var chartCOBData = [{
    data: cobAvg,
    label: translate('COB'),
    id: 'cobs',
    color: carbColor,
    points: { show: false },
    bars: { show: true, fil: true, barWidth: barWidth }
  }];
  var chartCOBOptions = {
    xaxis: xaxisCfg,
    yaxes: [{
      tickColor: tickColor,
      labelWidth: labelWidth,
      tickFormatter: function(val,axis) { return tickFormatter(val,axis); }
    },
    hiddenAxis],
    grid: {
      borderWidth: borderWidth,
      markings: markings
    }
  };
  var cobChart = $.plot( '#loopalyzer-cob', chartCOBData, chartCOBOptions );

};
