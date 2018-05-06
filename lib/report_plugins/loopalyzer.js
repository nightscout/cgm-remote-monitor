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
  var ret =
    '<h2>' + translate('Loopalyzer') + '</h2>'
    + '<span id="loopalyzer-help"><b>' + translate('To see this report, press SHOW while in this view') + '</b></span>'
    + '<div id="loopalyzer-buttons" style="display:none;">'
    + '<input type="button" onclick="loopalyzerBackward();" value="&lt;&lt;&nbsp;' + translate('Backward')+'">'
    + '<input type="button" onclick="loopalyzerForward();" value="' + translate('Forward')+'&nbsp;&gt;&gt;">'
    + '</div>'
    + '<div id="loopalyzer-charts" style="padding:20px;">'
    + '  <div class="chart" id="loopalyzer-basal" style="height:100px;margin-bottom:-14px;"></div>'
    + '  <div class="chart" id="loopalyzer-bg" style="height:200px;margin-bottom:-14px;"></div>'
    + '  <div class="chart" id="loopalyzer-tempbasal" style="height:150px;margin-bottom:-14px;"></div>'
    + '  <div class="chart" id="loopalyzer-iob" style="height:150px;margin-bottom:-14px;"></div>'
    + '  <div class="chart" id="loopalyzer-cob" style="height:150px;"></div>'
    + '</div>'
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
//  $('#loopalyzer-chart').html('');
//  $('#loopalyzer-charts').append($('<table><tr><td><div id="loopalyzerchart"></div></td><td><div id="loopalyzerstatchart"></td></tr></table>'));
};

loopalyzer.ss = require('simple-statistics');

loopalyzer.getSGVs = function(datastorage,daysToShow) {
  var data = datastorage.allstatsrecords;
  var bins = [];

  var filterFunc = function withinWindow(record) {
    var recdate = new Date(record.displayTime);
    return recdate.getHours() === hour && recdate.getMinutes() >= minute && recdate.getMinutes() < minute + minutewindow;
  };
  
  // Loop through all hours & minutes and days and get the readings, 
  // and push to bins so we can compute average etc later
  for (var hour = 0; hour < 24; hour++) {
    for (var minute = 0; minute < 60; minute = minute + minutewindow) {
      var date = new Date();
      date.setHours(hour);
      date.setMinutes(minute);
      date.setSeconds(0);
      var readings = data.filter(filterFunc);
      readings = readings.map(function(record) {
        return record.sgv;
      });
      bins.push([date, readings]);
      // console.log(date +  " - " + readings.length);
    }
  }
  return bins;
}


loopalyzer.getBasals = function(datastorage, daysToShow, profile) {
  var bins = [];

  // Loop through all hours & minutes and days and get the basal from profile, 
  // and push to bins so we can compute average etc later
  for (var hour = 0; hour < 24; hour++) {
    for (var minute = 0; minute < 60; minute = minute + minutewindow) {
      var basalValues = [];
      for (var m = 0; m < minutewindow; m = m + 5) {
        daysToShow.forEach(function(d) {
          var date = new Date(d);
          date.setHours(hour);
          date.setMinutes(minute + m);
          date.setSeconds(0);
          var basalValue = profile.getTempBasal(date);
          basalValues.push(basalValue.basal);
        });
      }
      var date = new Date();
      date.setHours(hour);
      date.setMinutes(minute);
      date.setSeconds(0);
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
        daysToShow.forEach(function(d) {
          var date = new Date(d);
          date.setHours(hour);
          date.setMinutes(minute + m);
          date.setSeconds(0);
          var basalValue = profile.getTempBasal(date);
          basalValues.push(basalValue.tempbasal - basalValue.basal);
        });
      }
      var date = new Date();
      date.setHours(hour);
      date.setMinutes(minute);
      date.setSeconds(0);
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
    var devicestatus = datastorage[day].devicestatus.filter(entry => entry.loop && entry.loop.iob);
    console.log("DEVICESTATUS for " + day, devicestatus);
    devicestatus.forEach(function(entry) {
      var minutesAfterMidnight = moment(entry.loop.iob.timestamp).diff(dayStart, 'minutes');
      var index = dayIndex * 288 + Math.floor(minutesAfterMidnight/5);
      iobs[index] = entry.loop.iob.iob; // Any index that has real data is updated, rest remain at NaN
    })
  });

  console.log("IOBS are", iobs);

  // Loop thru these entries and where no IOB has been found, extrapolate between the nearby so we get a continuous array
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
      // Compute the y=k*x+m = (y2-y1)/(x2-x1)*x+y1 = ( (iobs[stopIndex]-iobs[startIndex])/(stopIndex-startIndex) )*x + iobs[startIndex]
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
    bins.push([date, values]);
  }

  console.log("IOB BINS IS", bins);
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
    var devicestatus = datastorage[day].devicestatus.filter(entry => entry.loop && entry.loop.cob);
    console.log("DEVICESTATUS for " + day, devicestatus);
    devicestatus.forEach(function(entry) {
      var minutesAfterMidnight = moment(entry.loop.cob.timestamp).diff(dayStart, 'minutes');
      var index = dayIndex * 288 + Math.floor(minutesAfterMidnight/5);
      cobs[index] = entry.loop.cob.cob; // Any index that has real data is updated, rest remain at NaN
    })
  });

  console.log("COBS are", cobs);

  // Loop thru these entries and where no COB has been found, extrapolate between the nearby so we get a continuous array
  var startIndex = 0, stopIndex = 0;

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
      // Compute the y=k*x+m = (y2-y1)/(x2-x1)*x+y1 = ( (cobs[stopIndex]-cobs[startIndex])/(stopIndex-startIndex) )*x + cobs[startIndex]
      var k = (cobs[stopIndex] - cobs[startIndex]) / (stopIndex-startIndex);
      var m = cobs[startIndex];
      for (var x=0; x<(stopIndex-startIndex); x++) {
        cobs[x + startIndex] = k*x+m;
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
    bins.push([date, values]);
  }

  console.log("COB BINS IS", bins);
  return bins;
};


loopalyzer.dat10 = function(xBins) {
  return xBins.map(function(bin) {
    return [bin[0], loopalyzer.ss.quantile(bin[1], 0.1)];
  });
}
loopalyzer.dat25 = function(xBins) {
  return xBins.map(function(bin) {
    return [bin[0], loopalyzer.ss.quantile(bin[1], 0.25)];
  });
}
loopalyzer.dat50 = function(xBins) {
  return xBins.map(function(bin) {
    return [bin[0], loopalyzer.ss.quantile(bin[1], 0.5)]; 
  });
}
loopalyzer.dat75 = function(xBins) {
  return xBins.map(function(bin) {
    return [bin[0], loopalyzer.ss.quantile(bin[1], 0.75)];
  });
}
loopalyzer.dat90 = function(xBins) {
  return xBins.map(function(bin) {
    return [bin[0], loopalyzer.ss.quantile(bin[1], 0.9)];
  });
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


loopalyzer.report = function report_loopalyzer(datastorage,sorteddaystoshow,options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var profile = client.sbx.data.profile;
  var report_plugins = Nightscout.report_plugins;
  var scaledTreatmentBG = report_plugins.utils.scaledTreatmentBG;

  var padding = { top: 15, right: 22, bottom: 30, left: 35 };
  
  loopalyzer.prepareHtml();
  $("#loopalyzer-help").hide();
  $("#loopalyzer-buttons").show();

  // Copy the sorteddaystoshow into new array (clone) and re-sort ascending (so we don't mess with original array)
  var daysToShow = [];
  sorteddaystoshow.forEach(day => {daysToShow.push(day)});
  daysToShow.sort((a,b) => {return a>b});

  var high = options.targetHigh;
  var low = options.targetLow;

  var sgvBin = loopalyzer.getSGVs(datastorage,daysToShow);
  var sgvDat50 = loopalyzer.dat50(sgvBin);
  var basalsBin = loopalyzer.getBasals(datastorage,daysToShow,profile);
  var basalsDat50 = loopalyzer.dat50(basalsBin);
  var tempBasalsBin = loopalyzer.getTempBasalDeltas(datastorage,daysToShow,profile);
  var tempBasalsDat50 = loopalyzer.dat50(tempBasalsBin);
  var iobBin = loopalyzer.getIOBs(datastorage,daysToShow);
  var iobDat50 = loopalyzer.dat50(iobBin);
  var cobBin = loopalyzer.getCOBs(datastorage,daysToShow);
  var cobDat50 = loopalyzer.dat50(cobBin);

  function tickFormatter(val,axis) {
    if (val <= axis.min) { return ''; }
    if (val >= axis.max) { return ''; }
    return val + '';
  }

  var tickColor = "#CCCCCC";
  var barWidth = (24 * 60 * 60 * 1000 / 288);
  var borderWidth = 1;
  var labelWidth = 20;
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
    labelWidth: 5,
    tickColor: "#FFFFFF",
    font: { size: 0}
  }

  // Chart 1: Basal
  var chartBasalData = [{
    data: basalsDat50,
    label: translate('Basal profile'),
    id: 'basals',
    color: '#00AAFF',
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

    // Chart 2: Blood glucose
    var chartBGData = [{
      label: translate('Glucose'),
      data: sgvDat50,
      id: 'glucose',
      color: '#33AA33',
      points: { show: false },
      lines: { show: true }
    }];
    var chartBGOptions = {
      xaxis: xaxisCfg,
      yaxes: [{
        /* min: options.units === 'mmol' ? -2 : 36, */
        /* max: options.units === 'mmol' ? 16 : 290, */
        tickColor: tickColor,
        labelWidth: labelWidth,
        tickFormatter: function(val,axis) { return tickFormatter(val,axis); }
      },
      hiddenAxis],
      grid: {
        borderWidth: borderWidth,
        markings: [{ 
          color: "#D6FFD6",
          yaxis: {
            from: low,
            to: high
          }
        }]
      }
    };

  // Chart 3: Delta temp basals
  var chartTempBasalData = [{
    data: tempBasalsDat50,
    label: translate('Delta temp basal'),
    id: 'tempBasals',
    color: '#FF7100',
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
      borderWidth: borderWidth
    }
  };

  // Chart 4: IOB
  var chartIOBData = [{
    data: iobDat50,
    label: translate('IOB'),
    id: 'iobs',
    color: '#FF7100',
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
      borderWidth: borderWidth
    }
  };

    // Chart 5: COB
    var chartCOBData = [{
      data: cobDat50,
      label: translate('COB'),
      id: 'cobs',
      color: '#66CC66',
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
        borderWidth: borderWidth
      }
    };
  
  $.plot( '#loopalyzer-basal', chartBasalData, chartBasalOptions );
  $.plot( '#loopalyzer-bg', chartBGData, chartBGOptions );
  $.plot( '#loopalyzer-tempbasal', chartTempBasalData, chartTempBasalOptions );
  $.plot( '#loopalyzer-iob', chartIOBData, chartIOBOptions );

  delete xaxisCfg.font; // Remove the font config so HH:MM is shown on the last chart
  $.plot( '#loopalyzer-cob', chartCOBData, chartCOBOptions );

};
