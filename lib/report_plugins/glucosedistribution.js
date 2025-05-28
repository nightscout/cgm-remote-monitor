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
    '<b>' + translate('To see this report, press SHOW while in this view') + '</b><br>' +
    translate('Ranges') + ':' +
    '<input type="radio" name="rp_ranges" id="rp_customrange">' +
    '<label for="rp_customrange" class="translate">Custom</label>' +
    '&nbsp;' +
    '<input type="radio" name="rp_ranges" id="rp_noting" checked>' +
    '<label for="rp_noting" class="translate">Standards</label>' +
    '&nbsp;' +
    '<input type="radio" name="rp_ranges" id="rp_standardrange">' +
    '<label for="rp_standardrange" class="translate">Standards (detail)</label>' +
    '<h2>' +
    translate('Glucose distribution') +
    ' (' +
    '<span id="glucosedistribution-days"></span>' +
    ')' +
    '  </h2>' +
    '<table><tr>' +
    '<td rowspan="4" style="valign:middle;"><div id="glucosedistribution-overviewchart"></div></td>' +
    '<td><div id="glucosedistribution-report"></div></td>' +
    '</tr>' +
    '<tr><td align="center"><div id="glucosedistribution-preds"></div></td></tr>' +
    '<tr><td><div id="glucosedistribution-stability"></div></td></tr>' +
    '</table>' +
    '<br/>' +
    '<br/>' +
    '<br/><div id="explanation">' +
    '* ' + translate('This is only a rough estimation that can be very inaccurate and does not replace actual blood testing. The formula used is taken from:') +
      'Nathan, David M., et al. "Translating the A1C assay into estimated average glucose values." <i>Diabetes care</i> 31.8 (2008): 1473-1478.' + '<br/><br/>' +
    '** ' + translate('GMI is a different estimate of A1c, described in') +
      ' <a href="https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6196826/">' +
      '"Glucose Manage Indicator (GMI): A New Term for Estimating A1C from Continuous Glucose Monitoring"' + '</a>' + '<br/><br/>' +
    translate('Time in fluctuation and Time in rapid fluctuation measure the % of time during the examined period, during which the blood glucose has been changing relatively fast or rapidly. Lower values are better.') + '<br/><br/>' +
    translate('Mean Total Daily Change is a sum of the absolute value of all glucose excursions for the examined period, divided by the number of days. Lower is better.') + '<br/><br/>' +
    translate('Mean Hourly Change is a sum of the absolute value of all glucose excursions for the examined period, divided by the number of hours in the period. Lower is better.') + '<br/><br/>' +
    translate('Out of Range RMS is calculated by squaring the distance out of range for all glucose readings for the examined period, summing them, dividing by the count and taking the square root. This metric is similar to in-range percentage but weights readings far out of range higher. Lower values are better.') + '<br/><br/>' +
    translate('GVI (Glycemic Variability Index) is a measure developed by Dexcom, detailed') + ' ' +
    '<a href="https://web.archive.org/web/20160523152519/http://www.healthline.com/diabetesmine/a-new-view-of-glycemic-variability-how-long-is-your-line">' +
    translate('here') +
    '</a>.<br/><br/>' +
    translate('Glycaemia Risk Index (GRI)') + ' ' +
    translate('consolidates hypo and hyper exposure, and is outlined') + ' ' +
    '<a href="https://pubmed.ncbi.nlm.nih.gov/35348391/">' +
    translate('here') +
    '</a>.</div><br/><br/>' +
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
    '23<input type="checkbox" id="glucosedistribution-23" checked>';
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

glucosedistribution.report = function report_glucosedistribution (datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var displayUnits = Nightscout.client.settings.units;

  var haveAbove = 1;
  var haveBelow = 1;

  var ss = require('simple-statistics');

  var colors = ['#ff5454', '#f2957d', '#dfffb2', '#54c954', '#7df27d', '#76dd98', '#54dddd', '#54ffff'];
  var tablecolors = {
    SuperLow: '#ff5454'
    , Low: '#f2957d'
    , Lowish: '#dfffb2'
    , Normal: '#54c954'
    , Up: '#7df27d'
    , Elevated: '#76dd98'
    , High: '#54dddd'
    , SuperHigh: '#54ffff'
  };

  var enabledHours = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];

  var report = $('#glucosedistribution-report');
  report.empty();

  var preds = $('#glucosedistribution-preds');
  preds.empty();

  var stability = $('#glucosedistribution-stability');
  stability.empty();

  var result = {};
  var custom = 0;
  var noGravid = 0;
  var normalcols = 2;
  if ($('#rp_customrange').is(':checked', true)) {
    custom = 1;
    result['SuperLow']   = { ignore: 1 }
    result['Low']        = { ignore: 0, nextbottom: options.superLow }
    if (options.superLow < options.targetLow) {
      haveBelow = 1;
      result['Lowish']   = { ignore: 0, bottom: options.superLow, nextbottom: options.targetLow }
    } else {
      haveBelow = 0;
      result['Lowish']   = { ignore: 1 }
    }
    result['Normal']     = { ignore: 0, bottom: options.targetLow, top: options.targetHigh }
    result['Up']         = { ignore: 1 }
    if (options.superHigh > options.targetHigh) {
      result['Elevated'] = { ignore: 0, top: options.superHigh, nexttop: options.targetHigh }
      haveAbove = 1;
    } else {
      result['Elevated'] = { ignore: 1 }
      haveAbove = 0;
    }
    result['High']       = { ignore: 0, nexttop: options.superHigh }
    result['SuperHigh']  = { ignore: 1 }
    if (haveAbove + haveBelow == 0) {
      normalcols = 1;
    }
  } else if ($('#rp_noting').is(':checked', true)) {
    noGravid = 1;
    if (displayUnits === 'mmol') {
      result['SuperLow']  = { ignore: 0, nextbottom: client.utils.scaleMgdl(54) }
      result['Low']       = { ignore: 0, bottom: client.utils.scaleMgdl(54), nextbottom: client.utils.scaleMgdl(63) }
      result['Lowish']    = { ignore: 0, bottom: client.utils.scaleMgdl(63), nextbottom: client.utils.scaleMgdl(70) }
      result['Normal']    = { ignore: 0, bottom: client.utils.scaleMgdl(70), top: client.utils.scaleMgdl(140) }
      result['Up']        = { ignore: 1 }
      result['Elevated']  = { ignore: 0, top: client.utils.scaleMgdl(180), nexttop: client.utils.scaleMgdl(140) }
      result['High']      = { ignore: 0, top: client.utils.scaleMgdl(250), nexttop: client.utils.scaleMgdl(180) }
      result['SuperHigh'] = { ignore: 0, nexttop: client.utils.scaleMgdl(250) }
    } else {
      result['SuperLow']  = { ignore: 0, nextbottom: 54 }
      result['Low']       = { ignore: 0, bottom: 54, nextbottom: 63 }
      result['Lowish']    = { ignore: 0, bottom: 63, nextbottom: 70 }
      result['Normal']    = { ignore: 0, bottom: 70, top: 140 }
      result['Up']        = { ignore: 1 }
      result['Elevated']  = { ignore: 0, top: 180, nexttop: 140 }
      result['High']      = { ignore: 0, top: 250, nexttop: 180 }
      result['SuperHigh'] = { ignore: 0, nexttop: 250 }
    }
  } else {
    normalcols = 1;
    if (displayUnits === 'mmol') {
      result['SuperLow']  = { ignore: 0, nextbottom: client.utils.scaleMgdl(54) }
      result['Low']       = { ignore: 0, bottom: client.utils.scaleMgdl(54), nextbottom: client.utils.scaleMgdl(63) }
      result['Lowish']    = { ignore: 0, bottom: client.utils.scaleMgdl(63), nextbottom: client.utils.scaleMgdl(70) }
      result['Normal']    = { ignore: 0, bottom: client.utils.scaleMgdl(70), top: client.utils.scaleMgdl(120) }
      result['Up']        = { ignore: 0, top: client.utils.scaleMgdl(140), nexttop: client.utils.scaleMgdl(120) }
      result['Elevated']  = { ignore: 0, top: client.utils.scaleMgdl(180), nexttop: client.utils.scaleMgdl(140) }
      result['High']      = { ignore: 0, top: client.utils.scaleMgdl(250), nexttop: client.utils.scaleMgdl(180) }
      result['SuperHigh'] = { ignore: 0, nexttop: client.utils.scaleMgdl(250) }
    } else {
      result['SuperLow']  = { ignore: 0, nextbottom: 54 }
      result['Low']       = { ignore: 0, bottom: 54, nextbottom: 63 }
      result['Lowish']    = { ignore: 0, bottom: 63, nextbottom: 70 }
      result['Normal']    = { ignore: 0, bottom: 70, top: 120 }
      result['Up']        = { ignore: 0, top: 140, nexttop: 120 }
      result['Elevated']  = { ignore: 0, top: 180, nexttop: 140 }
      result['High']      = { ignore: 0, top: 250, nexttop: 180 }
      result['SuperHigh'] = { ignore: 0, nexttop: 250 }
    }
  }

  var normalRange = 0;
  if (displayUnits === 'mmol') {
    var lower = result['Normal'].bottom;
    var upper = result['Normal'].top;
    if (lower == client.utils.scaleMgdl(70)) {
      if (upper == client.utils.scaleMgdl(120)) {
        normalRange = 1;        // TISR
      } else if (upper == client.utils.scaleMgdl(140)) {
        normalRange = 2;        // TITR
      } else if (upper == client.utils.scaleMgdl(180)) {
        normalRange = 3;        // TIR
      }
    }
  } else {
    var bottom = result['Normal'].bottom;
    var top = result['Normal'].top;
    if (bottom == 70) {
      if (top == 120) {
        normalRange = 1;        // TISR
      } else if (top == 140) {
        normalRange = 2;        // TITR
      } else if (top == 180) {
        normalRange = 3;        // TIR
      }
    }
  }
  var upRange = 0;
  if (displayUnits === 'mmol') {
    if (result['Normal'].bottom == client.utils.scaleMgdl(70)) {
      if (result['Up'].top == client.utils.scaleMgdl(140)) {
        upRange = 2;    // TITR
      } else if (result['Up'].top == client.utils.scaleMgdl(180)) {
        upRange = 3;    // TIR
      }
    }
  } else {
    if (result['Normal'].bottom == 70) {
      if (result['Up'].top == 140) {
        upRange = 2;    // TITR
      } else if (result['Up'].top == 180) {
        upRange = 3;    // TIR
      }
    }
  }
  var elevRange = 0;
  if (displayUnits === 'mmol') {
    if (result['Normal'].bottom == client.utils.scaleMgdl(70)) {
      if (result['Elevated'].top == client.utils.scaleMgdl(140)) {
        elevRange = 2;  // TITR
      } else if (result['Elevated'].top == client.utils.scaleMgdl(180)) {
        elevRange = 3;  // TIR
      }
    }
  } else {
    if (result['Normal'].bottom == 70) {
      if (result['Elevated'].top == 140) {
        elevRange = 2;  // TITR
      } else if (result['Elevated'].top == 180) {
        elevRange = 3;  // TIR
      }
    }
  }
  var rangecols = 4;
  var extra = 0;
  if ($('#rp_extrarange').is(':checked', true)) {
    extra = 1;
    rangecols = 5;
  }
  if (!!noGravid) {
    rangecols = 3;
  }
  if (!!custom) {
    if (!!haveAbove) {
      rangecols = 3
    } else if (!!haveBelow) {
      rangecols = 2
    } else {
      rangecols = 1
    }
  }

  var stats = [];
  var table = $('<table class="centeraligned">');
  var thead = $('<tr/>');
  $('<th>' + translate('Range') + '</th>').appendTo(thead);
  $('<th colspan="' + rangecols + '">' + translate('% of Readings') + '</th>').appendTo(thead);
  $('<th>' + translate('# of Readings') + '</th>').appendTo(thead);
  $('<th>' + translate('Average') + '</th>').appendTo(thead);
  if (!noGravid) {
    $('<th>' + translate('Median') + '</th>').appendTo(thead);
  }
  $('<th>' + translate('Standard Deviation') + ' (' + translate('CV') + ')</th>').appendTo(thead);
  thead.appendTo(table);

  var predtable = $('<table class="centeraligned">');
  thead = $('<tr/>');
  $('<th></th>').appendTo(thead);
  $('<th>' + translate('eHbA1c') + '*</th>').appendTo(thead);
  $('<th>' + translate('GMI') + '**</th>').appendTo(thead);
  thead.appendTo(predtable);

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

  // data cleaning pass 0 - remove duplicates and non-sgv entries, sort
  var seen = [];
  data = data.filter(function(item) {
    if (!item.sgv || !item.bgValue || !item.displayTime || item.bgValue < 39) {
      console.log(item);
      return false;
    }
    return seen.includes(item.displayTime) ? false : (seen[item.displayTime] = true);
  });

  data.sort(function(a, b) {
    return a.displayTime.getTime() - b.displayTime.getTime();
  });

  var glucose_data = [];

  if (data.length === 0) {
    $('#glucosedistribution-days').text(translate('Result is empty'));
    return;
  }

  // data cleaning pass 1 - add interpolated missing points
  for (i = 0; i <= data.length - 2; i++) {
    var entry = data[i];
    var nextEntry = data[i + 1];

    var timeDelta = nextEntry.displayTime.getTime() - entry.displayTime.getTime();

    if (timeDelta < 9 * 60 * 1000 || timeDelta > 25 * 60 * 1000) {
      glucose_data.push(entry);
      continue;
    }

    var missingRecords = Math.floor(timeDelta / (5 * 60 * 1000)) - 1;

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

  // Calculate weighting based on average 106-day Hb lifespan (even if we don't display it yet).
  var wtotal = 0;
  var wdivisor = 0.001;
  let log106 = Math.log(106);
  var lastEntryTime = glucose_data[glucose_data.length - 1].displayTime.getTime();
  var timeTotal = 0;
  for (i = 1; i <= glucose_data.length - 2; i++) {
    let entry = glucose_data[i];
    let nextEntry = glucose_data[i + 1];
    let timeDelta = nextEntry.displayTime.getTime() - entry.displayTime.getTime();
    if (timeDelta < maxGap) {
      timeTotal += timeDelta;
    }
    let daysOld = (lastEntryTime - entry.displayTime.getTime()) / (1000.0 * 60 * 60 * 24);

    // w: weight. 1.0 for most recent. 0.0 for 106 days ago?

    // Flat
    //let w = 1.0;

    // Linear
    // let w = 1.0 - daysOld/106.0;

    // Log
    let w = 1.0;
    if (daysOld > 0) {
      w = 1.0 - Math.log(daysOld)/log106;
    }

    if (w > 0) {	// weight each value
      wtotal += w * entry.bgValue;
      wdivisor += w;
    }
  }
  var weighted = wtotal / wdivisor;

  var daysTotal = timeTotal / (1000 * 60 * 60 * 24);

  ['SuperLow', 'Low', 'Lowish', 'Normal', 'Up', 'Elevated', 'High', 'SuperHigh'].forEach(function(range) {
    var r = result[range];
    r.rangeRecords = glucose_data.filter(function(q) {
      r.readingspct = 0.0;
      if (!!r.ignore) {
        return 0;
      }
      if (q.sgv <= 0) {
        return 0;
      }

      if (typeof r.nexttop != 'undefined') {
        var aboveNext = q.sgv > r.nexttop;
        if (typeof r.top != 'undefined') {
          return aboveNext && q.sgv <= r.top;                   // elevated
        } else {
          return aboveNext;                                     // extreme high
        }
      }

      if (typeof r.nextbottom != 'undefined') {
        var belowNext = q.sgv < r.nextbottom;
        if (typeof r.bottom != 'undefined') {
          return belowNext && q.sgv >= r.bottom;                // lowish
        } else {
          return belowNext;                                     // extreme low
        }
      }

      if (typeof r.top != 'undefined' && typeof r.bottom != 'undefined') {
        return q.sgv >= r.bottom && q.sgv <= r.top;             // middle range
      }

      return 0;
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
  result.Normal.readingspct = (100 - result.Low.readingspct - result.Lowish.readingspct - result.Up.readingspct - result.Elevated.readingspct - result.High.readingspct - result.SuperLow.readingspct - result.SuperHigh.readingspct).toFixed(1);

  // Add up combined percentages

  var tar2 = parseFloat(result.SuperHigh.readingspct) + parseFloat(result.High.readingspct);
  var tar2count = !result.SuperHigh.ignore + !result.High.ignore;

  var tar3 = parseFloat(result.Elevated.readingspct) + parseFloat(tar2);
  var tar3count = !result.Elevated.ignore + tar2count;
  var preg3 = parseFloat(result.High.readingspct) + parseFloat(result.Elevated.readingspct);
  var preg3count = !noGravid * (!result.Elevated.ignore + !result.High.ignore);

  var tar4 = parseFloat(result.Up.readingspct) + parseFloat(tar3);
  var tar4count = !result.Up.ignore + tar3count;

  var preg1 = parseFloat(result.Normal.readingspct) + parseFloat(result.Lowish.readingspct);
  var preg2 = result.Up.readingspct + preg1;

  var titr = parseFloat(result.Normal.readingspct) + parseFloat(result.Up.readingspct);
  var titrcount = !result.Normal.ignore + !result.Up.ignore;
  var tir = parseFloat(titr) + parseFloat(result.Elevated.readingspct);
  var tircount = titrcount + !result.Elevated.ignore;

  var tbr1 = parseFloat(result.Low.readingspct) + parseFloat(result.SuperLow.readingspct);
  var tbr1count = !result.Low.ignore + !result.SuperLow.ignore;

  var tbr2 = parseFloat(tbr1) + parseFloat(result.Lowish.readingspct);
  var tbr2count = !result.Lowish.ignore + tbr1count;

  var tbr3 = parseFloat(result.Low.readingspct) + parseFloat(result.Lowish.readingspct);
  var tbr3count = !result.Lowish.ignore + !result.Low.ignore;

  var hypoComponent = parseFloat(result.SuperLow.readingspct) + 0.8 * (parseFloat(result.Low.readingspct) + parseFloat(result.Lowish.readingspct));
  var hyperComponent = parseFloat(result.SuperHigh.readingspct) + 0.5 * parseFloat(result.High.readingspct);
  var gri = 3.0 * hypoComponent + 1.6 * hyperComponent;
  if (gri > 100.0) {
    gri = 100.0;
  }

  var tar2 = parseFloat(tar2).toFixed(1);
  var tar3 = parseFloat(tar3).toFixed(1);
  var tar4 = parseFloat(tar4).toFixed(1);
  var preg1 = parseFloat(preg1).toFixed(1);
  var preg2 = parseFloat(preg2).toFixed(1);
  var preg3 = parseFloat(preg3).toFixed(1);
  var titr = parseFloat(titr).toFixed(1);
  var tir = parseFloat(tir).toFixed(1);
  var tbr1 = parseFloat(tbr1).toFixed(1);
  var tbr2 = parseFloat(tbr2).toFixed(1);
  var tbr3 = parseFloat(tbr3).toFixed(1);

  var topline = 1;

  ['SuperHigh', 'High', 'Elevated', 'Up', 'Normal', 'Lowish', 'Low', 'SuperLow'].forEach(function(range) {
    var tr = $('<tr>');
    var r = result[range];

    var first = '&nbsp;';
    if (typeof r.top != 'undefined') {
      first = r.top;
    }
    var second = '&nbsp;';
    if (typeof r.bottom != 'undefined') {
      second = r.bottom;
    }
    var rangelabel = '';
    if (!!topline) {
      rangelabel = '</font><br/><strong>' + translate('High') + '</strong><font size="-1">';
    }
    if (range == 'Normal') {
      if (!!custom) {
        rangelabel = '</font><br/><strong>' + translate('In Range') + '</strong><font size="-1">';
      } else {
        rangelabel = '<br/>';
      }
    }
    if (range == 'SuperLow' || (range == 'Low' && !!result['SuperLow'].ignore)) {
      rangelabel = '</font><br/><strong>' + translate('Low') + '</strong><font size="-1">';
    }
    $('<td class="tdborder" style="background-color:' + tablecolors[range] + '"><font size="-1">' + first + rangelabel + '<br/>' + second + '</font></td>').appendTo(tr);

    if (range == 'SuperHigh' || range == 'High') {
      $('<td class="tdborder">' + r.readingspct + '%</td>').appendTo(tr);
    }

    if (!!topline) {
      if (tar3count > 1) {
        $('<td class="tdborder" rowspan="' + tar3count + '" colspan="' + (1-custom) + '"><br/>' + tar3 + '%</td>').appendTo(tr);
      } else if (!!haveBelow && !noGravid && normalcols == 1) {
        $('<td></td>').appendTo(tr);
      }
      if (tar2count > 1) {
        $('<td class="tdborder" rowspan="' + tar2count + '"><br/>' + tar2 + '%</td>').appendTo(tr);
      } else if (!custom) {
        $('<td></td>').appendTo(tr);
      }
      if ((!!haveAbove || !!haveBelow) && !noGravid) {
        $('<td></td>').appendTo(tr);
      }
      if (!!extra) {
        if (tar4count > 1) {
          $('<td class="tdborder" rowspan="' + tar4count + '">' + tar4 + '%</td>').appendTo(tr);
        } else {
          $('<td></td>').appendTo(tr);
        }
      }
    }

    if (range == 'High' && !custom && !noGravid && preg3count > 0) {
      $('<td class="tdborder" rowspan="' + preg3count + '">' + preg3 + '%</td>').appendTo(tr);
    }

    if (range == 'Elevated') {
      $('<td class="tdborder">' + r.readingspct + '%</td>').appendTo(tr);
      if (tircount > 1) {
        if (elevRange == 2) {
          $('<td class="tdborder" style="background-color:' + tablecolors['Elevated'] + '" rowspan="' + tircount + '">' + translate('TITR') + '<br/><strong>' + tir + '%</strong></td>').appendTo(tr);
        } else if (elevRange == 3) {
          $('<td class="tdborder" style="background-color:' + tablecolors['Elevated'] + '" rowspan="' + tircount + '">' + translate('TIR') + '<br/><strong>' + tir + '%</strong></td>').appendTo(tr);
        } else {
          $('<td class="tdborder" rowspan="' + tircount + '">' + tir + '%</td>').appendTo(tr);
        }
      } else {
        $('<td></td>').appendTo(tr);
      }
    }

    if (range == 'Up') {
      $('<td class="tdborder">' + r.readingspct + '%</td>').appendTo(tr);
      if (titrcount > 1) {
        if (upRange == 2) {
          $('<td class="tdborder" style="background-color:' + tablecolors['Up'] + '" rowspan="' + titrcount + '">' + translate('TITR') + '<br/><strong>' + titr + '%</strong></td>').appendTo(tr);
        } else if (upRange == 3) {
          $('<td class="tdborder" style="background-color:' + tablecolors['Up'] + '" rowspan="' + titrcount + '">' + translate('TIR') + '<br/><strong>' + titr + '%</strong></td>').appendTo(tr);
        } else {
          $('<td class="tdborder" rowspan="' + titrcount + '">' + titr + '%</td>').appendTo(tr);
        }
      } else {
        $('<td></td>').appendTo(tr);
      }
      $('<td class="tdborder" style="background-color:' + tablecolors['Lowish'] + '" rowspan="3">' + translate('TING') + '<br/><strong>' + preg2 + '%</strong></td>').appendTo(tr);
    }

    if (range == 'Normal') {
      if (titrcount > 1) {
        $('<td class="tdborder" colspan="' + normalcols + '">' + r.readingspct + '%</td>').appendTo(tr);
      } else if (normalRange == 2) {
        $('<td class="tdborder" style="background-color:' + tablecolors['Normal'] + '" colspan="' + normalcols + '">' + translate('TITR') + '<br/><strong>' + r.readingspct + '%</strong></td>').appendTo(tr);
      } else if (normalRange == 3) {
        $('<td class="tdborder" style="background-color:' + tablecolors['Normal'] + '" colspan="' + normalcols + '">' + translate('TIR') + '<br/><strong>' + r.readingspct + '%</strong></td>').appendTo(tr);
      } else {
        $('<td class="tdborder" colspan="' + normalcols + '"><strong>' + r.readingspct + '%</strong></td>').appendTo(tr);
      }
      if (!!extra) {
        $('<td class="tdborder" rowspan="2">' + preg1 + '%</td>').appendTo(tr);
      }
      if (!!custom) {
        if ((!!haveAbove || !!haveBelow) && normalcols == 1) {
          $('<td></td>').appendTo(tr);
        }
      } else {
        if (!!noGravid && normalcols == 1) {
          $('<td></td>').appendTo(tr);
        }
      }
    }
    if (range == 'Lowish') {
      $('<td class="tdborder">' + r.readingspct + '%</td>').appendTo(tr);
      if (tbr2count > 1) {
        $('<td class="tdborder" rowspan="' + tbr2count + '"><br/><strong>' + tbr2 + '%</strong></td>').appendTo(tr);
      } else if (!!haveAbove) {
        $('<td></td>').appendTo(tr);
      }
      if (!custom && tbr3count > 1) {
        if (!noGravid) {
          $('<td class="tdborder" rowspan="' + tbr3count + '">' + tbr3 + '%</td>').appendTo(tr);
        } else {
          $('<td></td>').appendTo(tr);
        }
      } else if (!!haveAbove || !!noGravid) {
        $('<td></td>').appendTo(tr);
      }
    }

    if (range == 'Low') {
      $('<td class="tdborder">' + r.readingspct + '%</td>').appendTo(tr);
      if (tbr1count > 1) {
        $('<td class="tdborder" colspan="' + (1+extra) + '" rowspan="' + tbr1count + '"><br/><strong>' + tbr1 + '%</strong></td>').appendTo(tr);
      } else if (!!haveAbove) {
        $('<td colspan="' + (2*haveAbove-haveBelow) + '"></td>').appendTo(tr);
      }
      //if (!extra && !custom) {
        //$('<td rowspan="2"></td>').appendTo(tr);
      //}
    }
    if (range == 'SuperLow') {
      $('<td class="tdborder">' + r.readingspct + '%</td>').appendTo(tr);
      if (!custom && !noGravid) {
        $('<td></td>').appendTo(tr);
      }
    }

    $('<td class="tdborder">' + r.rangeRecords.length + '</td>').appendTo(tr);
    if (r.rangeRecords.length > 0) {
      $('<td class="tdborder">' + (Math.round(10 * r.mean) / 10).toFixed(1) + '</td>').appendTo(tr);
      if (!noGravid) {
        $('<td class="tdborder">' + (Math.round(10 * r.median) / 10).toFixed(1) + '</td>').appendTo(tr);
      }
      $('<td class="tdborder">' + (Math.round(10 * r.stddev) / 10).toFixed(1) + '</td>').appendTo(tr);
    } else {
      $('<td class="tdborder">n/a</td>').appendTo(tr);
      if (!noGravid) {
        $('<td class="tdborder">n/a</td>').appendTo(tr);
      }
      $('<td class="tdborder">n/a</td>').appendTo(tr);
    }

    if (!!r.ignore) {
      ; // Hide these as they're obviously not wanted.
    } else {
      table.append(tr);
      topline = 0;
    }
  });

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

  var tr = $('<tr>');
  $('<td class="tdborder"><strong>' + translate('Overall') + ': </strong></td>').appendTo(tr);
  $('<td colspan="' + rangecols + '"> </td>').appendTo(tr);
  var per_day = (glucose_data.length * 1.0 / daysTotal).toFixed(0);
  $('<td class="tdborder">' + glucose_data.length + ' (' + per_day + translate('/day') + ')</td>').appendTo(tr);

  if (glucose_data.length > 0) {
    $('<td class="tdborder">' + (Math.round(10 * ss.mean(localBgs)) / 10).toFixed(1) + '</td>').appendTo(tr);
    if (!noGravid) {
      $('<td class="tdborder">' + (Math.round(10 * ss.quantile(localBgs, 0.5)) / 10).toFixed(1) + '</td>').appendTo(tr);
    }
    $('<td class="tdborder">' + (Math.round(ss.standard_deviation(localBgs) * 10) / 10).toFixed(1) + '<br/>(<strong>' + (Math.round(100*(ss.standard_deviation(localBgs)/ss.mean(localBgs)))).toFixed(0) + '%</strong>)</td>').appendTo(tr);
  } else {
    $('<td class="tdborder">n/a</td>').appendTo(tr);
    if (!noGravid) {
      $('<td class="tdborder">n/a</td>').appendTo(tr);
    }
    $('<td class="tdborder">n/a</td>').appendTo(tr);
  }
  table.append(tr);
  report.append(table);

  if (glucose_data.length > 0) {
    //let a1c_weighted = (weighted + 46.7) / 28.7;
    //let a1cwd = (Math.round(10 * a1c_weighted) / 10).toFixed(1);
    //let a1cwi = Math.round((a1c_weighted - 2.15) * 10.929);
    //let gmiw = (Math.round(10*(weighted * 0.02392 + 3.31))/10).toFixed(1);

    let a1c_mean = (ss.mean(mgDlBgs) + 46.7) / 28.7;
    let a1cmd = (Math.round(10 * a1c_mean) / 10).toFixed(1);
    let a1cmi = Math.round((a1c_mean - 2.15) * 10.929);
    let gmim = (Math.round(10*(ss.mean(mgDlBgs) * 0.02392 + 3.31))/10).toFixed(1);

    var predtr = $('<tr>');
    $('<td></td>').appendTo(predtr);
    $('<td class="tdborder"><center><strong>' + a1cmd + '%<sub>DCCT</sub> ' + a1cmi + '<sub>IFCC</sub></strong></center></td>').appendTo(predtr);
    $('<td class="tdborder"><center>' + gmim + '%</center></td>').appendTo(predtr);
    predtable.append(predtr);
    preds.append(predtable);
  } else {
    $('<td></td>').appendTo(predtr);
    $('<td class="tdborder">n/a</td>').appendTo(predtr);
    $('<td class="tdborder">n/a</td>').appendTo(predtr);
    predtable.append(predtr);
    preds.append(predtable);
  }

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

  $('<tr><th>' + translate('Mean Hourly Change') + '</th><th>' + translate('Out of Range RMS') + '</th><th>' + translate('GVI') + '</th></tr>').appendTo(stabilitytable);
  $('<tr><td class="tdborder">' + TDCHourly + unitString + '</td><td class="tdborder">' + Math.round(RMS * 100) / 100 + unitString + '</td><td class="tdborder">' + GVI + '</td></tr>').appendTo(stabilitytable);

  if (!custom && !noGravid) {
    $('<tr><th>' + translate('Glycaemia Risk Index (GRI)') + '</th><th>' + translate('Hypo Component') + '</th><th>' + translate('Hyper Component') + '</th></tr>').appendTo(stabilitytable);
    $('<tr><td class="tdborder">' + Math.round(gri) + '</td><td class="tdborder">' + (Math.round(10 * hypoComponent) / 10).toFixed(1) + '%</td><td class="tdborder">' + (Math.round(10*hyperComponent)/10).toFixed(1) + '%</td></tr>').appendTo(stabilitytable);
  }

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

  function onClick () {
    report_glucosedistribution(datastorage, sorteddaystoshow, options);
  }
};
