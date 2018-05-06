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
    + '<b>' + translate('To see this report, press SHOW while in this view') + '</b><br>'
    /*
    + translate('Display') + ': '
    + '<input type="checkbox" id="rp_optionsinsulin" checked><span style="color:blue;opacity:0.5">'+translate('Insulin')+'</span>'
    + '<input type="checkbox" id="rp_optionscarbs" checked><span style="color:red;opacity:0.5">'+translate('Carbs')+'</span>'
    + '<input type="checkbox" id="rp_optionsbasal" checked><span style="color:#0099ff;opacity:0.5">'+translate('Basal rate')+'</span>'
    + '<input type="checkbox" id="rp_optionsraw"><span style="color:gray;opacity:1">'+translate('Raw')+'</span>'
    + '<input type="checkbox" id="rp_optionsiob"><span style="color:blue;opacity:0.5">'+translate('IOB')+'</span>'
    + '<input type="checkbox" id="rp_optionscob"><span style="color:red;opacity:0.5">'+translate('COB')+'</span>'
    + '<input type="checkbox" id="rp_optionspredicted"><span style="color:sienna;opacity:0.5">'+translate('Predictions')+'</span>'
    + '&nbsp;'+translate('Size')
    + ' <select id="rp_size">'
    + '  <option x="800" y="250">800x250px</option>'
    + '  <option x="1000" y="300">1000x300px</option>'
    + '  <option x="1200" y="400">1200x400px</option>'
    + '  <option x="1550" y="600" selected>1550x600px</option>'
    + '  <option x="2400" y="800">2400x800px</option>'
    + '</select>'
    */
    + '<br>'
    + '<div id="loopalyzer-charts" style="padding:20px;">'
    + '  <div class="chart" id="loopalyzer-chart1" style="height:300px;"></div>'
    + '  <div class="chart" id="loopalyzer-chart2" style="height:200px;"></div>'
    + '  <div class="chart" id="loopalyzer-chart3" style="height:200px;"></div>'
    + '</div>'
    ;
    return ret;
};

loopalyzer.css =
    '#loopalyzer-chart1, #loopalyzer-chart2, #loopalyzer-chart3 {'
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
    var devicestatus = datastorage[day].devicestatus.filter(entry => entry.loop && entry.loop.iob); //.sort((a,b) => {return (a.loop.iob.timestamp<b.loop.iob.timestamp);});
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
    var devicestatus = datastorage[day].devicestatus.filter(entry => entry.loop && entry.loop.cob); //.sort((a,b) => {return (a.loop.cob.timestamp<b.loop.cob.timestamp);});
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

  var high = options.targetHigh;
  var low = options.targetLow;

  // Copy the sorteddaystoshow into new array (clone) and re-sort ascending (so we don't mess with original array)
  var daysToShow = [];
  sorteddaystoshow.forEach(day => {daysToShow.push(day)});
  daysToShow.sort((a,b) => {return a<b});

  var sgvBin = loopalyzer.getSGVs(datastorage,daysToShow);
  var sgvDat50 = loopalyzer.dat50(sgvBin);

  var basalsBin = loopalyzer.getBasals(datastorage,daysToShow,profile);
  var basalsDat50 = loopalyzer.dat50(basalsBin);

  var tempBasalsBin = loopalyzer.getTempBasalDeltas(datastorage,daysToShow,profile);
  var tempBasalsDat50 = loopalyzer.dat50(tempBasalsBin);

  console.log("GETTING IOB BIN");
  var iobBin = loopalyzer.getIOBs(datastorage,daysToShow);
  var iobDat50 = loopalyzer.dat50(iobBin);

  console.log("GETTING COB BIN");
  var cobBin = loopalyzer.getCOBs(datastorage,daysToShow);
  var cobDat50 = loopalyzer.dat50(cobBin);

  console.log("GOT THEM");
  console.log("cobDat50",cobDat50);

  var barWidth = (24 * 60 * 60 * 1000 / 288);
  var sgvMin = loopalyzer.min(sgvDat50);
  var sgvMax = loopalyzer.max(sgvDat50);
  var basalsMin = loopalyzer.min(basalsDat50);
  var basalsMax = loopalyzer.max(basalsDat50);
  var tempBasalsMin = loopalyzer.min(tempBasalsDat50);
  var tempBasalsMax = loopalyzer.max(tempBasalsDat50);
  var iobMin = loopalyzer.min(iobDat50);
  var iobMax = loopalyzer.max(iobDat50);
  var cobMin = loopalyzer.min(cobDat50);
  var cobMax = loopalyzer.max(cobDat50);

  console.log("SGV " + sgvMin + " - " + sgvMax);
  console.log("Basals " + basalsMin + " - " + basalsMax);
  console.log("TempBasals " + tempBasalsMin + " - " + tempBasalsMax);
  console.log("IOB " + iobMin + " - " + iobMax);
  console.log("COB " + cobMin + " - " + cobMax);

  var tickColor = "#CCCCCC";
  var borderWidth = 1;
  var labelWidth = 25;
  var xaxisCfg = {
      mode: 'time',
      timezone: 'browser',
      timeformat: '%H:%M',
      tickColor: tickColor,
      tickSize: [1, "hour"]
  };

  // Chart 1 is BG and basal profile chart
  var chart1Data = [{
    label: translate('Glucose'),
    data: sgvDat50,
    id: 'glucose',
    color: '#33AA33',
    points: { show: false },
    lines: { show: true }
  }, {
    data: basalsDat50,
    label: translate('Basal profile'),
    id: 'basals',
    color: '#00AAFF',
    points: { show: false },
    bars: { show: true, fill: true, barWidth: barWidth },
    yaxis: 2
  }];

  var chart1Options = {
    legend: { noColumns: 0 },
    xaxis: xaxisCfg,
    yaxes: [{ /* First axis is glucose */
      min: options.units === 'mmol' ? -5 : 0,
      /* max: options.units === 'mmol' ? 16 : 290, */
      tickColor: tickColor,
      labelWidth: labelWidth,
      position: "left",
    }, { /* Second axis is basal profile */
      min: 0,
      max: basalsMax*4,
      tickColor: tickColor,
      labelWidth: labelWidth,
      position: "right",
    }],
    grid: {
      borderWidth: borderWidth,
      /* margin: { left:10, right:0 }, */
      markings: [{ 
        color: "#D6FFD6",
        y1axis: {
          from: low,
          to: high
        }
      },{ 
        color: "#CCCCFF",
        y2axis: {
          from: 0,
          to: 0
        }
      }],
    }
  };

  // Chart 2 is delta temp basals chart
  var chart2Data = [{
    data: tempBasalsDat50,
    label: translate('Delta temp basal'),
    id: 'tempBasals',
    color: '#FF7100',
    points: { show: false },
    bars: { show: true, barWidth: barWidth }
  }];

  var chart2Options = {
    xaxis: xaxisCfg,
    yaxes: [{
      /* min: tempBasalsMin,
      max: tempBasalsMax, */
      tickColor: tickColor,
      labelWidth: labelWidth,
    },{
      position: "right",
      tickColor: "#FFFFFF",
      labelWidth: labelWidth,
      font: { size: 0 },
      show: true
    }],
    grid: {
      borderWidth: borderWidth,
      /* margin: { left:12, right:27 } */
    }
  };

  // Chart 3 are IOB and COB
  var chart3Data = [{
    data: iobDat50,
    label: translate('IOB'),
    id: 'iobs',
    color: '#FF7100',
    points: { show: false },
    bars: { show: true, barWidth: barWidth },
    yaxis: 1
  }, {
    data: cobDat50,
    label: translate('COB'),
    id: 'cobs',
    color: '#00AAFF',
    points: { show: false },
    lines: { show: true },
    yaxis: 2
  }];

  var chart3Options = {
    legend: { noColumns: 2 },
    xaxis: xaxisCfg,
    yaxes: [{ /* First axis is IOB */
      tickColor: tickColor,
      labelWidth: labelWidth,
      position: "left",
    }, { /* Second axis is COB */
      tickColor: tickColor,
      labelWidth: labelWidth,
      position: "right",
      alignTicksWithAxis:1,
      min: -20
    }],
    grid: {
      borderWidth: borderWidth,
      /* margin: { left:0, right:4 }, */
    }
  };

  
  $.plot( '#loopalyzer-chart1', chart1Data, chart1Options );
  $.plot( '#loopalyzer-chart2', chart2Data, chart2Options );
  $.plot( '#loopalyzer-chart3', chart3Data, chart3Options );

};
