'use strict';

var consts = require('../constants');

var dailystats = {
  name: 'dailystats'
  , label: 'Daily Stats'
  , pluginType: 'report'
};

function init () {
  return dailystats;
}

module.exports = init;

dailystats.html = function html (client) {
  var translate = client.translate;
  var ret =
    '<h2>' + translate('Daily stats report') + '</h2>' +
    '<div id="dailystats-report"></div>';
  return ret;
};

dailystats.css =
  '#dailystats-placeholder {' +
  '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;' +
  '}' +
  '#dailystats-placeholder .tdborder {' +
  '  width:80px;' +
  '  border: 1px #ccc solid;' +
  '  margin: 0;' +
  '  padding: 1px;' +
  '  text-align:center;' +
  '}' +
  '#dailystats-placeholder .tir-bar {' +
  '  width: 140px;' +
  '  height: 16px;' +
  '  border-radius: 4px;' +
  '  overflow: hidden;' +
  '  display: flex;' +
  '  border: 1px solid #ccc;' +
  '  background: #fff;' +
  '}' +
  '#dailystats-placeholder .tir-seg {' +
  '  height: 100%;' +
  '  -webkit-print-color-adjust: exact;' +
  '  print-color-adjust: exact;' +
  '}';

dailystats.report = function report_dailystats (datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var report_plugins = Nightscout.report_plugins;

  var ss = require('simple-statistics');

  var todo = [];
  var report = $('#dailystats-report');
  var minForDay, maxForDay, sum;

  report.empty();
  var table = $('<table class="centeraligned">');
  report.append(table);
  var thead = $('<tr/>');
  $('<th></th>').appendTo(thead);
  $('<th>' + translate('Date') + '</th>').appendTo(thead);
  $('<th>' + translate('Low') + '</th>').appendTo(thead);
  $('<th>' + translate('Normal') + '</th>').appendTo(thead);
  $('<th>' + translate('High') + '</th>').appendTo(thead);
  $('<th>' + translate('Readings') + '</th>').appendTo(thead);
  $('<th>' + translate('Min') + '</th>').appendTo(thead);
  $('<th>' + translate('Max') + '</th>').appendTo(thead);
  $('<th>' + translate('Average') + '</th>').appendTo(thead);
  $('<th>' + translate('StDev') + '</th>').appendTo(thead);
  $('<th>' + translate('25%') + '</th>').appendTo(thead);
  $('<th>' + translate('Median') + '</th>').appendTo(thead);
  $('<th>' + translate('75%') + '</th>').appendTo(thead);
  $('<th>' + translate('A1c est* %<sub>DCCT</sub>') + '</th>').appendTo(thead);
  $('<th>' + translate('A1c est* <sub>IFCC</sub>') + '</th>').appendTo(thead);
  thead.appendTo(table);

  sorteddaystoshow.forEach(function(day) {
    var tr = $('<tr>');

    var daysRecords = datastorage[day].statsrecords;

    if (daysRecords.length === 0) {
      $('<td/>').appendTo(tr);
      $('<td class="tdborder" style="width:160px">' + report_plugins.utils.localeDate(day) + '</td>').appendTo(tr);
      $('<td  class="tdborder"colspan="10">' + translate('No data available') + '</td>').appendTo(tr);
      table.append(tr);
      return;
    }

    minForDay = daysRecords[0].sgv;
    maxForDay = daysRecords[0].sgv;
    sum = 0;

    var stats = daysRecords.reduce(function(out, record) {
      record.sgv = parseFloat(record.sgv);
      if (record.sgv < options.targetLow) {
        out.lows++;
      } else if (record.sgv < options.targetHigh) {
        out.normal++;
      } else {
        out.highs++;
      }
      if (minForDay > record.sgv) {
        minForDay = record.sgv;
      }
      if (maxForDay < record.sgv) {
        maxForDay = record.sgv;
      }
      sum += record.sgv;
      return out;
    }, {
      lows: 0
      , normal: 0
      , highs: 0
    });
    var average = sum / daysRecords.length;
    var averageA1cDCCT = (average * consts.MMOL_TO_MGDL + 46.7) / 28.7;
    var averageA1cIFCC = ((average * consts.MMOL_TO_MGDL + 46.7) / 28.7 - 2.15) * 10.929;

    var bgValues = daysRecords.map(function(r) { return r.sgv; });

    var lowPct = Math.round((100 * stats.lows) / daysRecords.length);
    var normalPct = Math.round((100 * stats.normal) / daysRecords.length);
    var highPct = Math.round((100 * stats.highs) / daysRecords.length);
    var barTitle = translate('Low') + ': ' + lowPct + '%, ' +
      translate('In Range') + ': ' + normalPct + '%, ' +
      translate('High') + ': ' + highPct + '%';
    var bar = '<div class="tir-bar" title="' + barTitle + '">' +
      '<div class="tir-seg" style="width:' + lowPct + '%;background:#ff5959;"></div>' +
      '<div class="tir-seg" style="width:' + normalPct + '%;background:#4caf50;"></div>' +
      '<div class="tir-seg" style="width:' + highPct + '%;background:#ffe358;"></div>' +
      '</div>';
    $('<td>' + bar + '</td>').appendTo(tr);

    $('<td class="tdborder" style="width:160px">' + report_plugins.utils.localeDate(day) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + Math.round((100 * stats.lows) / daysRecords.length) + '%</td>').appendTo(tr);
    $('<td class="tdborder">' + Math.round((100 * stats.normal) / daysRecords.length) + '%</td>').appendTo(tr);
    $('<td class="tdborder">' + Math.round((100 * stats.highs) / daysRecords.length) + '%</td>').appendTo(tr);
    $('<td class="tdborder">' + daysRecords.length + '</td>').appendTo(tr);
    $('<td class="tdborder">' + minForDay + '</td>').appendTo(tr);
    $('<td class="tdborder">' + maxForDay + '</td>').appendTo(tr);
    $('<td class="tdborder">' + average.toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + ss.standard_deviation(bgValues).toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + ss.quantile(bgValues, 0.25).toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + ss.quantile(bgValues, 0.5).toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + ss.quantile(bgValues, 0.75).toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + averageA1cDCCT.toFixed(1) + '%</td>').appendTo(tr);
    $('<td class="tdborder">' + averageA1cIFCC.toFixed(0) + '</td>').appendTo(tr);

    table.append(tr);
  });

  setTimeout(function() {
    todo.forEach(function(fn) {
      fn();
    });
  }, 50);
};
