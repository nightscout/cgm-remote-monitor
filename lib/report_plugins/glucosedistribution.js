'use strict';

var glucosedistribution = {
  name: 'glucosedistribution'
  , label: 'Distribution'
  , pluginType: 'report'
};

function init() {
  return glucosedistribution;
}

module.exports = init;

glucosedistribution.html = function html(client) {
  var translate = client.translate;
  var ret =
    '<h2>' +
    translate('Glucose distribution') +
    '  (' +
    '  <span id="glucosedistribution-days"></span>' +
    '  )' +
    '  </h2>' +
    '<table><tr>' +
    '<td rowspan="2" style="valign:middle;"><div id="glucosedistribution-overviewchart"></div></td>' +
    '<td><div id="glucosedistribution-report"></div></td>' +
    '</tr>' +
    '<tr><td><div id="glucosedistribution-stability"></div></td></tr>' +
    '</table>' +
    '<br/>' +
    '<br/>' +
    '<br/><div id="explanation">' +
    '* ' + translate('This is only a rough estimation that can be very inaccurate and does not replace actual blood testing. The formula used is taken from:') +
    'Nathan, David M., et al. "Translating the A1C assay into estimated average glucose values." <i>Diabetes care</i> 31.8 (2008): 1473-1478.' + '<br/><br/>' +
    translate('Time in fluctuation and Time in rapid fluctuation measure the % of time during the examined period, during which the blood glucose has been changing relatively fast or rapidly. Lower values are better.') + '<br/><br/>' +
    translate('Mean Total Daily Change is a sum of the absolute value of all glucose excursions for the examined period, divided by the number of days. Lower is better.') + '<br/><br/>' +
    translate('Mean Hourly Change is a sum of the absolute value of all glucose excursions for the examined period, divided by the number of hours in the period. Lower is better.') + '<br/><br/>' +
    translate('Out of Range RMS is calculated by squaring the distance out of range for all glucose readings for the examined period, summing them, dividing by the count and taking the square root. This metric is similar to in-range percentage but weights readings far out of range higher. Lower values are better.') + '<br/><br/>' +
    translate('GVI (Glycemic Variability Index) and PGS (Patient Glycemic Status) are measures developed by Dexcom, detailed <a href="') +
    'https://web.archive.org/web/20160523152519/http://www.healthline.com/diabetesmine/a-new-view-of-glycemic-variability-how-long-is-your-line' +
    translate('">can be found here</a>.') +
    '</div><br/><br/>' +
    translate('Filter by hours') + ':' +
    '<br/>' +
    '0<input type="checkbox" id="glucosedistribution-0" checked>' +
    '1<input type="checkbox" id="glucosedistribution-1" checked>' +
    '2<input type="checkbox" id="glucosedistribution-2" checked>' +
    '3<input type="checkbox" id="glucosedistribution-3" checked>' +
    '4<input type="checkbox" id="glucosedistribution-4" checked>' +
    '5<input type="checkbox" id="glucosedistribution-5" checked>' +
    '6<input type="checkbox" id="glucosedistribution-6" checked>' +
    '7<input type="checkbox" id="glucosedistribution-7" checked>' +
    '8<input type="checkbox" id="glucosedistribution-8" checked>' +
    '9<input type="checkbox" id="glucosedistribution-9" checked>' +
    '10<input type="checkbox" id="glucosedistribution-10" checked>' +
    '11<input type="checkbox" id="glucosedistribution-11" checked>' +
    '12<input type="checkbox" id="glucosedistribution-12" checked>' +
    '13<input type="checkbox" id="glucosedistribution-13" checked>' +
    '14<input type="checkbox" id="glucosedistribution-14" checked>' +
    '15<input type="checkbox" id="glucosedistribution-15" checked>' +
    '16<input type="checkbox" id="glucosedistribution-16" checked>' +
    '17<input type="checkbox" id="glucosedistribution-17" checked>' +
    '18<input type="checkbox" id="glucosedistribution-18" checked>' +
    '19<input type="checkbox" id="glucosedistribution-19" checked>' +
    '20<input type="checkbox" id="glucosedistribution-20" checked>' +
    '21<input type="checkbox" id="glucosedistribution-21" checked>' +
    '22<input type="checkbox" id="glucosedistribution-22" checked>' +
    '23<input type="checkbox" id="glucosedistribution-23" checked>'
  ;
  return ret;
};

glucosedistribution.css =
  '#glucosedistribution-overviewchart {' +
  '  width: 2.4in;' +
  '  height: 2.4in;' +
  '}' +
  '#glucosedistribution-placeholder .tdborder {' +
  '  width:80px;' +
  '  border: 1px #ccc solid;' +
  '  margin: 0;' +
  '  padding: 1px;' +
  '    text-align:center;' +
  '}';

glucosedistribution.report = function report_glucosedistribution(datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var displayUnits = Nightscout.client.settings.units;

  var ss = require('simple-statistics');

  var colors = ['#f88', '#8f8', '#ff8'];
  var tablecolors = {
    Low: '#f88'
    , Normal: '#8f8'
    , High: '#ff8'
  };

  var enabledHours = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];

  var report = $('#glucosedistribution-report');
  report.empty();

  var stability = $('#glucosedistribution-stability');
  stability.empty();

  var stats = [];
  var table = $('<table class="centeraligned">');
  var thead = $('<tr/>');
  $('<th>' + translate('Range') + '</th>').appendTo(thead);
  $('<th>' + translate('% of Readings') + '</th>').appendTo(thead);
  $('<th>' + translate('# of Readings') + '</th>').appendTo(thead);
  $('<th>' + translate('Average') + '</th>').appendTo(thead);
  $('<th>' + translate('Median') + '</th>').appendTo(thead);
  $('<th>' + translate('Standard Deviation') + '</th>').appendTo(thead);
  $('<th>' + translate('A1c estimation*') + '</th>').appendTo(thead);
  thead.appendTo(table);

  var data = datastorage.allstatsrecords;
  var days = datastorage.alldays;

  $('#glucosedistribution-days').text(days + ' ' + translate('days total'));

  for (var i = 0; i < 23; i++) {
    $('#glucosedistribution-' + i).unbind('click').click(onClick);
    enabledHours[i] = $('#glucosedistribution-' + i).is(':checked');
  }

  var result = {};

  // Filter data for noise
  // data cleaning pass 0 - remove duplicates and non-sgv entries, sort
  var seen = {};
  data = data.filter(function(item) {
    if (!item.sgv || !item.bgValue || !item.displayTime || item.bgValue < 39) {
      console.log(item);
      return false;
    }
    return seen.hasOwnProperty(item.displayTime) ? false : (seen[item.displayTime] = true);
  });

  data.sort(function(a, b) {
    return a.displayTime.getTime() - b.displayTime.getTime();
  });

  var glucose_data = [data[0]];

  // data cleaning pass 1 - add interpolated missing points
  for (var i = 0; i <= data.length - 2; i++) {
    var entry = data[i];
    var nextEntry = data[i + 1];

    var timeDelta = nextEntry.displayTime.getTime() - entry.displayTime.getTime();

    if (timeDelta < 9 * 60 * 1000 || timeDelta > 25 * 60 * 1000) {
      glucose_data.push(entry);
      continue;
    }

    var missingRecords = Math.floor(timeDelta / (5 * 60 * 990)) - 1;

    var timePatch = Math.floor(timeDelta / (missingRecords + 1));
    var bgDelta = (nextEntry.bgValue - entry.bgValue) / (missingRecords + 1);

    glucose_data.push(entry);

    for (var j = 1; j <= missingRecords; j++) {
      var bg = Math.floor(entry.bgValue + bgDelta * j);
      var t = new Date(entry.displayTime.getTime() + j * timePatch);
      var newEntry = {
        sgv: displayUnits === 'mmol' ? bg / 18 : bg
        , bgValue: bg
        , displayTime: t
      };
      glucose_data.push(newEntry);
    }
  }
  // Need to add the last record, after interpolating between points
  glucose_data.push(data[data.length - 1]);

  // data cleaning pass 2 - replace single jumpy measures with interpolated values
  var glucose_data2 = [glucose_data[0]];
  var prevEntry = glucose_data[0];

  const maxGap = (5 * 60 * 1000) + 10000;

  for (var i = 1; i <= glucose_data.length - 2; i++) {
    var entry = glucose_data[i];
    var nextEntry = glucose_data[i + 1];

    var timeDelta = nextEntry.displayTime.getTime() - entry.displayTime.getTime();
    var timeDelta2 = entry.displayTime.getTime() - prevEntry.displayTime.getTime();

    if (timeDelta > maxGap || timeDelta2 > maxGap) {
      glucose_data2.push(entry);
      prevEntry = entry;
      continue;
    }

    var delta1 = entry.bgValue - prevEntry.bgValue;
    var delta2 = nextEntry.bgValue - entry.bgValue;

    if (delta1 <= 8 && delta2 <= 8) {
      glucose_data2.push(entry);
      prevEntry = entry;
      continue;
    }

    if ((delta1 > 0 && delta2 < 0) || (delta1 < 0 && delta2 > 0)) {
      const d = (nextEntry.bgValue - prevEntry.bgValue) / 2;
      const interpolatedValue = prevEntry.bgValue + d;

      var newEntry = {
        sgv: displayUnits === 'mmol' ? interpolatedValue/18 : interpolatedValue
        , bgValue: interpolatedValue
        , displayTime: entry.displayTime
      };
      glucose_data2.push(newEntry);
      prevEntry = newEntry;
      continue;
    }

    glucose_data2.push(entry);
    prevEntry = entry;
  }
  // Need to add the last record, after interpolating between points
  glucose_data2.push(glucose_data[glucose_data.length - 1]);

  glucose_data = data = glucose_data2.filter(function(r) {
    return enabledHours[new Date(r.displayTime).getHours()]
  });

  glucose_data.sort(function(a, b) {
    return a.displayTime.getTime() - b.displayTime.getTime();
  });

  var timeTotal = 0;
  for (var i = 1; i <= glucose_data.length - 2; i++) {
    var entry = glucose_data[i];
    var nextEntry = glucose_data[i + 1];
    var timeDelta = nextEntry.displayTime.getTime() - entry.displayTime.getTime();
    if (timeDelta < maxGap) {
      timeTotal += timeDelta;
    }
  }

  var daysTotal = timeTotal / (1000 * 60 * 60 * 24);

  ['Low', 'Normal', 'High'].forEach(function(range) {
    result[range] = {};
    var r = result[range];
    r.rangeRecords = glucose_data.filter(function(r) {
      if (range === 'Low') {
        return r.sgv > 0 && r.sgv < options.targetLow;
      } else if (range === 'Normal') {
        return r.sgv >= options.targetLow && r.sgv < options.targetHigh;
      } else {
        return r.sgv >= options.targetHigh;
      }
    });
    stats.push(r.rangeRecords.length);
    r.rangeRecords.sort(function(a, b) {
      return a.sgv - b.sgv;
    });
    r.localBgs = r.rangeRecords.map(function(r) {
      return r.sgv;
    }).filter(function(bg) {
      return !!bg;
    });
    r.midpoint = Math.floor(r.rangeRecords.length / 2);
    r.readingspct = (100 * r.rangeRecords.length / data.length).toFixed(1);
    if (r.rangeRecords.length > 0) {
      r.mean = Math.floor(10 * ss.mean(r.localBgs)) / 10;
      r.median = r.rangeRecords[r.midpoint].sgv;
      r.stddev = Math.floor(ss.standard_deviation(r.localBgs) * 10) / 10;
    }
  });

  // make sure we have total 100%
  result.Normal.readingspct = (100 - result.Low.readingspct - result.High.readingspct).toFixed(1);

  ['Low', 'Normal', 'High'].forEach(function(range) {
    var tr = $('<tr>');
    var r = result[range];

    var rangeExp = '';
    if (range == 'Low') {
      rangeExp = ' (<' + options.targetLow + ')';
    }
    if (range == 'High') {
      rangeExp = ' (>=' + options.targetHigh + ')';
    }

    $('<td class="tdborder" style="background-color:' + tablecolors[range] + '"><strong>' + translate(range) + rangeExp + ': </strong></td>').appendTo(tr);
    $('<td class="tdborder">' + r.readingspct + '%</td>').appendTo(tr);
    $('<td class="tdborder">' + r.rangeRecords.length + '</td>').appendTo(tr);
    if (r.rangeRecords.length > 0) {
      $('<td class="tdborder">' + r.mean.toFixed(1) + '</td>').appendTo(tr);
      $('<td class="tdborder">' + r.median.toFixed(1) + '</td>').appendTo(tr);
      $('<td class="tdborder">' + r.stddev.toFixed(1) + '</td>').appendTo(tr);
      $('<td> </td>').appendTo(tr);
    } else {
      $('<td class="tdborder">N/A</td>').appendTo(tr);
      $('<td class="tdborder">N/A</td>').appendTo(tr);
      $('<td class="tdborder">N/A</td>').appendTo(tr);
      $('<td class="tdborder"> </td>').appendTo(tr);
    }

    table.append(tr);
  });

  var tr = $('<tr>');
  $('<td class="tdborder"><strong>' + translate('Overall') + ': </strong></td>').appendTo(tr);
  $('<td> </td>').appendTo(tr);
  $('<td class="tdborder">' + glucose_data.length + '</td>').appendTo(tr);
  if (glucose_data.length > 0) {
    var localBgs = glucose_data.map(function(r) {
      return r.sgv;
    }).filter(function(bg) {
      return !!bg;
    });
    var mgDlBgs = glucose_data.map(function(r) {
      return r.bgValue;
    }).filter(function(bg) {
      return !!bg;
    });
    $('<td class="tdborder">' + (Math.round(10 * ss.mean(localBgs)) / 10).toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + (Math.round(10 * ss.quantile(localBgs, 0.5)) / 10).toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + (Math.round(ss.standard_deviation(localBgs) * 10) / 10).toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder"><center>' + (Math.round(10 * (ss.mean(mgDlBgs) + 46.7) / 28.7) / 10).toFixed(1) + '%<sub>DCCT</sub> | ' + Math.round(((ss.mean(mgDlBgs) + 46.7) / 28.7 - 2.15) * 10.929) + '<sub>IFCC</sub></center></td>').appendTo(tr);
  } else {
    $('<td class="tdborder">N/A</td>').appendTo(tr);
    $('<td class="tdborder">N/A</td>').appendTo(tr);
    $('<td class="tdborder">N/A</td>').appendTo(tr);
    $('<td class="tdborder">N/A</td>').appendTo(tr);
  }
  table.append(tr);
  report.append(table);

  // Stability
  var t1 = 6;
  var t2 = 11;
  var t1count = 0;
  var t2count = 0;

  var events = 0;

  var GVITotal = 0;
  var GVIIdeal = 0;
  var GVIIdeal_Time = 0;

  var RMSTotal = 0;

  var usedRecords = 0;
  var glucoseTotal = 0;
  var deltaTotal = 0;

  for (var i = 0; i <= glucose_data.length - 2; i++) {
    var entry = glucose_data[i];
    var nextEntry = glucose_data[i + 1];

    var timeDelta = nextEntry.displayTime.getTime() - entry.displayTime.getTime();

    // Use maxGap constant
    if (timeDelta == 0 || timeDelta > maxGap) { // 6 * 60 * 1000) {
      // console.log("Record skipped");
      continue;
    }

    usedRecords += 1;
    events += 1;

    var delta = Math.abs(nextEntry.bgValue - entry.bgValue);
    deltaTotal += delta;

    if (delta > 0) { // avoid divide by 0 error
      // Are we rising at faster than 5mg/DL/5minutes
      if ((delta / timeDelta) >= (t1 / (1000 * 60 * 5))) {
        t1count += 1;
      }
      // Are we rising at faster than 10mg/DL/5minutes
      if ((delta / timeDelta) >= (t2 / (1000 * 60 * 5))) {
        t2count += 1;
      }
    }

    // Calculate the distance travelled for this time step
    GVITotal += Math.sqrt(Math.pow(timeDelta / (1000 * 60), 2) + Math.pow(delta, 2));

    // Keep track of the number of minutes in this timestep
    GVIIdeal_Time += timeDelta / (1000 * 60);
    glucoseTotal += entry.bgValue;

    if (entry.bgValue < options.targetLow) {
      RMSTotal += Math.pow(options.targetLow - entry.bgValue, 2);
    }
    if (entry.bgValue > options.targetHigh) {
      RMSTotal += Math.pow(entry.bgValue - options.targetHigh, 2);
    }
  }

  // Difference between first and last reading
  var GVIDelta = Math.floor(glucose_data[0].bgValue - glucose_data[glucose_data.length - 1].bgValue);

  // Delta for total time considered against total period rise
  GVIIdeal = Math.sqrt(Math.pow(GVIIdeal_Time, 2) + Math.pow(GVIDelta, 2));

  var GVI = Math.round(GVITotal / GVIIdeal * 100) / 100;
  console.log('GVI', GVI, 'GVIIdeal', GVIIdeal, 'GVITotal', GVITotal, 'GVIIdeal_Time', GVIIdeal_Time);

  var glucoseMean = Math.floor(glucoseTotal / usedRecords);
  var tirMultiplier = result.Normal.readingspct / 100.0;
  var PGS = Math.round(GVI * glucoseMean * (1 - tirMultiplier) * 100) / 100;
  console.log('glucoseMean', glucoseMean, 'tirMultiplier', tirMultiplier, 'PGS', PGS);

  var TDC = deltaTotal / daysTotal;
  var TDCHourly = TDC / 24.0;

  var RMS = Math.sqrt(RMSTotal / events);

  //  console.log('TADC',TDC,'days',days);

  var timeInT1 = Math.round(100 * t1count / events).toFixed(1);
  var timeInT2 = Math.round(100 * t2count / events).toFixed(1);

  var unitString = ' mg/dl';
  if (displayUnits == 'mmol') {
    TDC = TDC / 18.0;
    TDCHourly = TDCHourly / 18.0;
    unitString = ' mmol/L';

    RMS = Math.sqrt(RMSTotal / events) / 18;
  }

  TDC = Math.round(TDC * 100) / 100;
  TDCHourly = Math.round(TDCHourly * 100) / 100;

  var stabilitytable = $('<table style="width: 100%;">');

  var t1exp = '>5 mg/dl/5m';
  var t2exp = '>10 mg/dl/5m';
  if (displayUnits == 'mmol') {
    t1exp = '>0.27 mmol/l/5m';
    t2exp = '>0.55 mmol/l/5m';
  }

  $('<tr><th>' + translate('Mean Total Daily Change') + '</th><th>' + translate('Time in fluctuation') + '<br>(' + t1exp + ')</th><th>' + translate('Time in rapid fluctuation') + '<br>(' + t2exp + ')</th></tr>').appendTo(stabilitytable);
  $('<tr><td class="tdborder">' + TDC + unitString + '</td><td class="tdborder">' + timeInT1 + '%</td><td class="tdborder">' + timeInT2 + '%</td></tr>').appendTo(stabilitytable);

  $('<tr><th>' + translate('Mean Hourly Change') + '</th><th>GVI</th><th>PGS</th></tr>').appendTo(stabilitytable);
  $('<tr><td class="tdborder">' + TDCHourly + unitString + '</td><td class="tdborder">' + GVI + '</td><td class="tdborder">' + PGS + '</td></tr>').appendTo(stabilitytable);

  $('<tr><th>Out of Range RMS</th></tr>').appendTo(stabilitytable);
  $('<tr><td class="tdborder">' + Math.round(RMS * 100) / 100 + unitString + '</td></tr>').appendTo(stabilitytable);
  stabilitytable.appendTo(stability);

  setTimeout(function() {
    $.plot(
      '#glucosedistribution-overviewchart'
      , stats, {
        series: {
          pie: {
            show: true
          }
        }
        , colors: colors
      }
    );
  });

  function onClick() {
    report_glucosedistribution(datastorage, sorteddaystoshow, options);
  }
};
