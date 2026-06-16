'use strict';

var consts = require('../constants');

var glucosedistribution = {
  name: 'glucosedistribution'
  , label: 'Distribution'
  , pluginType: 'report'
};

function init () {
  return glucosedistribution;
}

module.exports = init;

glucosedistribution.html = function html (client) {
  var translate = client.translate;
  var ret =
    '<div class="gd-wrap">' +
    '<h2 class="gd-title">' +
    translate('Glucose distribution') +
    ' (' +
    '<span id="glucosedistribution-days"></span>' +
    ')' +
    '  </h2>' +
    '<div id="glucosedistribution-summary" class="gd-summary"></div>' +
    '<div id="glucosedistribution-rangeselect" class="gd-rangeselect">' +
    '<b>' + translate('Range metrics') + ':</b> ' +
    '<input type="radio" name="glucosedistribution-rangemode" id="glucosedistribution-rangemode-tir" value="tir" checked>' +
    '<label for="glucosedistribution-rangemode-tir">' + translate('Time in Range') + '</label> ' +
    '<input type="radio" name="glucosedistribution-rangemode" id="glucosedistribution-rangemode-tight" value="tight">' +
    '<label for="glucosedistribution-rangemode-tight">' + translate('Time in Tight Range') + '</label> ' +
    '<input type="radio" name="glucosedistribution-rangemode" id="glucosedistribution-rangemode-tinr" value="tinr">' +
    '<label for="glucosedistribution-rangemode-tinr">' + translate('Time in Normal Range') + '</label> ' +
    '<input type="radio" name="glucosedistribution-rangemode" id="glucosedistribution-rangemode-custom" value="custom">' +
    '<label for="glucosedistribution-rangemode-custom">' + translate('Custom (report targets)') + '</label>' +
    '</div>' +
    '<div class="gd-main">' +
    '<div id="glucosedistribution-overviewchart" class="gd-tirchart"></div>' +
    '<div class="gd-card gd-reportcard"><div id="glucosedistribution-report"></div></div>' +
    '</div>' +
    '<div class="gd-card gd-stability"><div id="glucosedistribution-stability"></div></div>' +
    '<div class="gd-hours">' +
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
    '23<input type="checkbox" id="glucosedistribution-23" checked>' +
    '</div>' +
    '<div id="explanation" class="gd-explanation">' +
    '* ' + translate('This is only a rough estimation that can be very inaccurate and does not replace actual blood testing. The formula used is taken from:') +
    'Nathan, David M., et al. "Translating the A1C assay into estimated average glucose values." <i>Diabetes care</i> 31.8 (2008): 1473-1478.' + '<br/><br/>' +
    '** ' + translate('GMI (Glucose Management Indicator) estimates the laboratory A1c from the mean glucose. Time in Range is the percentage of readings between 70-180 mg/dL (3.9-10.0 mmol/L), Time in Tight Range between 70-140 mg/dL (3.9-7.8 mmol/L), and Time in Normal Range between 63-140 mg/dL (3.5-7.8 mmol/L); higher is better. CV (coefficient of variation) reflects glucose variability; 36% or lower is commonly considered stable.') + '<br/><br/>' +
    translate('Time in fluctuation and Time in rapid fluctuation measure the % of time during the examined period, during which the blood glucose has been changing relatively fast or rapidly. Lower values are better.') + '<br/><br/>' +
    translate('Mean Total Daily Change is a sum of the absolute value of all glucose excursions for the examined period, divided by the number of days. Lower is better.') + '<br/><br/>' +
    translate('Mean Hourly Change is a sum of the absolute value of all glucose excursions for the examined period, divided by the number of hours in the period. Lower is better.') + '<br/><br/>' +
    translate('Out of Range RMS is calculated by squaring the distance out of range for all glucose readings for the examined period, summing them, dividing by the count and taking the square root. This metric is similar to in-range percentage but weights readings far out of range higher. Lower values are better.') + '<br/><br/>' +
    translate('GVI (Glycemic Variability Index) and PGS (Patient Glycemic Status) are measures developed by Dexcom, detailed <a href="') +
    'https://web.archive.org/web/20160523152519/http://www.healthline.com/diabetesmine/a-new-view-of-glycemic-variability-how-long-is-your-line' +
    translate('">can be found here</a>.') +
    '</div>' +
    '</div>';
  return ret;
};

glucosedistribution.css =
  '.gd-wrap { color: #222; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Rounded", system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }' +
  '.gd-title { margin-bottom: 8px; }' +
  '.gd-summary { margin: 6px 0 16px 0; }' +
  '.gd-rangeselect { margin-bottom: 16px; }' +
  /* two-column: vertical bar on the left, stats table on the right */
  '.gd-main {' +
  '  display: flex;' +
  '  gap: 18px;' +
  '  align-items: stretch;' +
  '  margin: 8px 0 18px 0;' +
  '  flex-wrap: wrap;' +
  '}' +
  '#glucosedistribution-overviewchart { flex: 0 0 auto; display: flex; align-items: stretch; }' +
  '.gd-vbar {' +
  '  width: 66px;' +
  '  min-height: 340px;' +
  '  display: flex;' +
  '  flex-direction: column;' +
  '  border-radius: 8px;' +
  '  overflow: hidden;' +
  '  border: 1px solid #bbb;' +
  '  -webkit-print-color-adjust: exact;' +
  '  print-color-adjust: exact;' +
  '}' +
  '.gd-vseg {' +
  '  width: 100%;' +
  '  display: flex;' +
  '  align-items: center;' +
  '  justify-content: center;' +
  '  color: #fff;' +
  '  font-weight: bold;' +
  '  font-size: 11px;' +
  '  line-height: 1;' +
  '  overflow: hidden;' +
  '  text-shadow: 0 1px 1px rgba(0,0,0,0.35);' +
  '  -webkit-print-color-adjust: exact;' +
  '  print-color-adjust: exact;' +
  '}' +
  '.gd-reportcard { flex: 1 1 360px; min-width: 300px; }' +
  '.gd-stability { margin: 4px 0 18px 0; }' +
  '.gd-card {' +
  '  border: 1px solid #e4e7eb;' +
  '  border-radius: 12px;' +
  '  padding: 14px;' +
  '  box-sizing: border-box;' +
  '  box-shadow: 0 1px 3px rgba(0,0,0,0.08);' +
  '  background: #fff;' +
  '}' +
  '.gd-summary table, #glucosedistribution-report table, #glucosedistribution-stability table { width: 100%; }' +
  '.gd-hours { margin: 18px 0; }' +
  '.gd-explanation { margin-top: 12px; }' +
  '#glucosedistribution-report .tdborder, #glucosedistribution-stability .tdborder, #glucosedistribution-summary .tdborder {' +
  '  border: 1px #ccc solid;' +
  '  margin: 0;' +
  '  padding: 4px 8px;' +
  '  text-align: center;' +
  '  -webkit-print-color-adjust: exact;' +
  '  print-color-adjust: exact;' +
  '}';

glucosedistribution.report = function report_glucosedistribution (datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var displayUnits = Nightscout.client.settings.units;

  var ss = require('simple-statistics');

  function bgNum (mgdl) {
    if (displayUnits === 'mmol') {
      return (mgdl / consts.MMOL_TO_MGDL).toFixed(1);
    }
    return '' + mgdl;
  }

  var enabledHours = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];

  var report = $('#glucosedistribution-report');
  report.empty();

  var stability = $('#glucosedistribution-stability');
  stability.empty();

  var summary = $('#glucosedistribution-summary');
  summary.empty();

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

  var reportPlugins = Nightscout.report_plugins;
  var firstDay = reportPlugins.utils.localeDate(sorteddaystoshow[sorteddaystoshow.length - 1]);
  var lastDay = reportPlugins.utils.localeDate(sorteddaystoshow[0]);

  $('#glucosedistribution-days').text(days + ' ' + translate('days total') + ', ' + firstDay + ' - ' + lastDay);

  for (var i = 0; i < 24; i++) {
    $('#glucosedistribution-' + i).unbind('click').click(onClick);
    enabledHours[i] = $('#glucosedistribution-' + i).is(':checked');
  }

  $('input[name="glucosedistribution-rangemode"]').unbind('change').on('change', onClick);
  var rangeMode = $('input[name="glucosedistribution-rangemode"]:checked').val() || 'tir';

  var bands;
  if (rangeMode === 'custom') {
    bands = [
      { key: 'Low', label: 'Low', exp: ' (<' + options.targetLow + ')', color: '#ff5959', filter: function(r) { return r.sgv > 0 && r.sgv < options.targetLow; } }
      , { key: 'Normal', label: 'In Range', exp: '', color: '#4caf50', filter: function(r) { return r.sgv >= options.targetLow && r.sgv < options.targetHigh; } }
      , { key: 'High', label: 'High', exp: ' (>=' + options.targetHigh + ')', color: '#ffe358', filter: function(r) { return r.sgv >= options.targetHigh; } }
    ];
  } else if (rangeMode === 'tight') {
    bands = [
      { key: 'VeryLow', label: 'Very Low', exp: ' (<' + bgNum(54) + ')', color: '#b71c1c', filter: function(r) { return r.bgValue < 54; } }
      , { key: 'Low', label: 'Low', exp: ' (' + bgNum(54) + '–' + bgNum(69) + ')', color: '#ff5959', filter: function(r) { return r.bgValue >= 54 && r.bgValue < 70; } }
      , { key: 'InTightRange', label: 'In Tight Range', exp: ' (' + bgNum(70) + '–' + bgNum(140) + ')', color: '#4caf50', filter: function(r) { return r.bgValue >= 70 && r.bgValue <= 140; } }
      , { key: 'InRange', label: 'In Range', exp: ' (' + bgNum(141) + '–' + bgNum(180) + ')', color: '#2e7d32', filter: function(r) { return r.bgValue > 140 && r.bgValue <= 180; } }
      , { key: 'High', label: 'High', exp: ' (' + bgNum(181) + '–' + bgNum(250) + ')', color: '#ffe358', filter: function(r) { return r.bgValue > 180 && r.bgValue <= 250; } }
      , { key: 'VeryHigh', label: 'Very High', exp: ' (>' + bgNum(250) + ')', color: '#ffb74d', filter: function(r) { return r.bgValue > 250; } }
    ];
  } else if (rangeMode === 'tinr') {
    bands = [
      { key: 'VeryLow', label: 'Very Low', exp: ' (<' + bgNum(54) + ')', color: '#b71c1c', filter: function(r) { return r.bgValue < 54; } }
      , { key: 'Low', label: 'Low', exp: ' (' + bgNum(54) + '–' + bgNum(62) + ')', color: '#ff5959', filter: function(r) { return r.bgValue >= 54 && r.bgValue < 63; } }
      , { key: 'InNormalRange', label: 'In Normal Range', exp: ' (' + bgNum(63) + '–' + bgNum(140) + ')', color: '#4caf50', filter: function(r) { return r.bgValue >= 63 && r.bgValue <= 140; } }
      , { key: 'InRange', label: 'In Range', exp: ' (' + bgNum(141) + '–' + bgNum(180) + ')', color: '#2e7d32', filter: function(r) { return r.bgValue > 140 && r.bgValue <= 180; } }
      , { key: 'High', label: 'High', exp: ' (' + bgNum(181) + '–' + bgNum(250) + ')', color: '#ffe358', filter: function(r) { return r.bgValue > 180 && r.bgValue <= 250; } }
      , { key: 'VeryHigh', label: 'Very High', exp: ' (>' + bgNum(250) + ')', color: '#ffb74d', filter: function(r) { return r.bgValue > 250; } }
    ];
  } else {
    bands = [
      { key: 'VeryLow', label: 'Very Low', exp: ' (<' + bgNum(54) + ')', color: '#b71c1c', filter: function(r) { return r.bgValue < 54; } }
      , { key: 'Low', label: 'Low', exp: ' (' + bgNum(54) + '–' + bgNum(69) + ')', color: '#ff5959', filter: function(r) { return r.bgValue >= 54 && r.bgValue < 70; } }
      , { key: 'InRange', label: 'In Range', exp: ' (' + bgNum(70) + '–' + bgNum(180) + ')', color: '#4caf50', filter: function(r) { return r.bgValue >= 70 && r.bgValue <= 180; } }
      , { key: 'High', label: 'High', exp: ' (' + bgNum(181) + '–' + bgNum(250) + ')', color: '#ffe358', filter: function(r) { return r.bgValue > 180 && r.bgValue <= 250; } }
      , { key: 'VeryHigh', label: 'Very High', exp: ' (>' + bgNum(250) + ')', color: '#ffb74d', filter: function(r) { return r.bgValue > 250; } }
    ];
  }

  // Filter data for noise
  // data cleaning pass 0 - remove duplicates and non-sgv entries, sort
  var seen = {};
  data = data.filter(function(item) {
    if (!item.sgv || !item.bgValue || !item.displayTime || item.bgValue < 39) {
      return false;
    }
    var key = item.displayTime.getTime();
    if (seen[key]) { return false; }
    seen[key] = true;
    return true;
  });

  if (data.length === 0) {
    $('#glucosedistribution-days').text(translate('Result is empty'));
    return;
  }

  data.sort(function(a, b) {
    return a.displayTime.getTime() - b.displayTime.getTime();
  });

  var glucose_data = [data[0]];

  // data cleaning pass 1 - add interpolated missing points
  for (i = 0; i <= data.length - 2; i++) {
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
        sgv: displayUnits === 'mmol' ? bg / consts.MMOL_TO_MGDL : bg
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

  for (i = 1; i <= glucose_data.length - 2; i++) {
    let entry = glucose_data[i];
    let nextEntry = glucose_data[i + 1];

    let timeDelta = nextEntry.displayTime.getTime() - entry.displayTime.getTime();
    let timeDelta2 = entry.displayTime.getTime() - prevEntry.displayTime.getTime();

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

      let newEntry = {
        sgv: displayUnits === 'mmol' ? interpolatedValue / consts.MMOL_TO_MGDL : interpolatedValue
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
  for (i = 1; i <= glucose_data.length - 2; i++) {
    let entry = glucose_data[i];
    let nextEntry = glucose_data[i + 1];
    let timeDelta = nextEntry.displayTime.getTime() - entry.displayTime.getTime();
    if (timeDelta < maxGap) {
      timeTotal += timeDelta;
    }
  }

  var daysTotal = timeTotal / (1000 * 60 * 60 * 24);

  bands.forEach(function(band) {
    var r = band.result = {};
    r.rangeRecords = glucose_data.filter(band.filter);
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

  // make sure we have total 100% - adjust the largest band for rounding errors
  var largestBand = bands[0];
  bands.forEach(function(band) {
    if (band.result.rangeRecords.length > largestBand.result.rangeRecords.length) {
      largestBand = band;
    }
  });
  var pctOthers = 0;
  bands.forEach(function(band) {
    if (band !== largestBand) {
      pctOthers += Number(band.result.readingspct);
    }
  });
  largestBand.result.readingspct = (100 - pctOthers).toFixed(1);

  bands.forEach(function(band) {
    var tr = $('<tr>');
    var r = band.result;

    $('<td class="tdborder" style="background-color:' + band.color + '"><strong>' + translate(band.label) + band.exp + ': </strong></td>').appendTo(tr);
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

  // Key metrics summary strip - always computed from mg/dl values regardless of mode
  var bgValues = glucose_data.map(function(r) {
    return r.bgValue;
  });

  function countWhere (test) {
    var count = 0;
    for (var k = 0; k < bgValues.length; k++) {
      if (test(bgValues[k])) {
        count += 1;
      }
    }
    return count;
  }

  function pctDisplay (count) {
    if (bgValues.length === 0) {
      return 'N/A';
    }
    return (100 * count / bgValues.length).toFixed(1) + '%';
  }

  var tirCount = countWhere(function(bg) { return bg >= 70 && bg <= 180; });
  var titrCount = countWhere(function(bg) { return bg >= 70 && bg <= 140; });
  var tinrCount = countWhere(function(bg) { return bg >= 63 && bg <= 140; });
  var below70Count = countWhere(function(bg) { return bg < 70; });
  var below54Count = countWhere(function(bg) { return bg < 54; });
  var above180Count = countWhere(function(bg) { return bg > 180; });
  var above250Count = countWhere(function(bg) { return bg > 250; });

  var GMI = 'N/A';
  var CV = 'N/A';
  if (bgValues.length > 0) {
    var bgMean = ss.mean(bgValues);
    GMI = (3.31 + 0.02392 * bgMean).toFixed(1) + '%';
    if (bgMean > 0) {
      CV = (100 * ss.standard_deviation(bgValues) / bgMean).toFixed(1) + '%';
    }
  }

  var summarytable = $('<table class="centeraligned">');
  var summaryhead = $('<tr/>');
  var summaryrow = $('<tr/>');
  [
    { label: translate('Time in Range') + '<br>(' + bgNum(70) + '–' + bgNum(180) + ')', value: pctDisplay(tirCount) }
    , { label: translate('Time in Tight Range') + '<br>(' + bgNum(70) + '–' + bgNum(140) + ')', value: pctDisplay(titrCount) }
    , { label: translate('Time in Normal Range') + '<br>(' + bgNum(63) + '–' + bgNum(140) + ')', value: pctDisplay(tinrCount) }
    , { label: translate('Time Below') + '<br>(<' + bgNum(70) + ')', value: pctDisplay(below70Count) }
    , { label: translate('Time Below') + '<br>(<' + bgNum(54) + ')', value: pctDisplay(below54Count) }
    , { label: translate('Time Above') + '<br>(>' + bgNum(180) + ')', value: pctDisplay(above180Count) }
    , { label: translate('Time Above') + '<br>(>' + bgNum(250) + ')', value: pctDisplay(above250Count) }
    , { label: translate('GMI') + '**', value: GMI }
    , { label: translate('CV') + '**', value: CV }
  ].forEach(function(metric) {
    $('<th>' + metric.label + '</th>').appendTo(summaryhead);
    $('<td class="tdborder">' + metric.value + '</td>').appendTo(summaryrow);
  });
  summaryhead.appendTo(summarytable);
  summaryrow.appendTo(summarytable);
  summarytable.appendTo(summary);

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

  for (i = 0; i <= glucose_data.length - 2; i++) {
    const entry = glucose_data[i];
    const nextEntry = glucose_data[i + 1];
    const timeDelta = nextEntry.displayTime.getTime() - entry.displayTime.getTime();

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
  var inRangePct;
  if (rangeMode === 'custom') {
    inRangePct = Number(bands[1].result.readingspct); // In Range band from report targets
  } else {
    inRangePct = bgValues.length > 0 ? 100 * tirCount / bgValues.length : 0; // consensus 70-180 mg/dl
  }
  var tirMultiplier = inRangePct / 100.0;
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
    TDC = TDC / consts.MMOL_TO_MGDL;
    TDCHourly = TDCHourly / consts.MMOL_TO_MGDL;
    unitString = ' mmol/L';

    RMS = Math.sqrt(RMSTotal / events) / consts.MMOL_TO_MGDL;
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

  // Vertical stacked Time-in-Range bar (AGP / Statistics Summary style).
  // Rendered to the left of the per-band stats table; ordered high glucose at
  // the top, low at the bottom.
  var overview = $('#glucosedistribution-overviewchart');
  overview.empty();

  var vbar = $('<div class="gd-vbar">');

  bands.slice().reverse().forEach(function(band) {
    var pct = Number(band.result.readingspct);
    if (isNaN(pct)) {
      pct = 0;
    }
    var label = translate(band.label) + band.exp;
    var pctText = band.result.readingspct + '%';

    var seg = $('<div class="gd-vseg">');
    seg.css('height', pct + '%');
    seg.css('background-color', band.color);
    seg.attr('title', label + ': ' + pctText);
    if (pct >= 5) {
      seg.text(pctText);
    }
    vbar.append(seg);
  });

  overview.append(vbar);

  function onClick () {
    report_glucosedistribution(datastorage, sorteddaystoshow, options);
  }
};
