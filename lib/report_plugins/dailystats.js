'use strict';

var chartStyle = require('../report/chart-style');

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
    chartStyle.html('dailystats', translate) +
    '<div id="dailystats-report"></div>';
  return ret;
};

dailystats.report = function report_dailystats (datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var report_plugins = Nightscout.report_plugins;

  var ss = require('../report/statistics');

  var todo = [];
  var charts = [];
  var selectedStyle = chartStyle.bind('dailystats', function (style) {
    selectedStyle = style;
    renderCharts();
  });
  var report = $('#dailystats-report');
  var minForDay, maxForDay, sum, sumMgdl;

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
      $('<td class="tdborder dailystats-date">' + report_plugins.utils.localeDate(day) + '</td>').appendTo(tr);
      $('<td  class="tdborder"colspan="10">' + translate('No data available') + '</td>').appendTo(tr);
      table.append(tr);
      return;
    }

    minForDay = daysRecords[0].sgv;
    maxForDay = daysRecords[0].sgv;
    sum = 0;
    sumMgdl = 0;

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
      sumMgdl += record.bgValue;
      return out;
    }, {
      lows: 0
      , normal: 0
      , highs: 0
    });
    var average = sum / daysRecords.length;
    // bgValue retains the original mg/dL reading; sgv is rounded in display units.
    var averageMgdl = sumMgdl / daysRecords.length;
    var averageA1cDCCT = (averageMgdl + 46.7) / 28.7;
    var averageA1cIFCC = (averageA1cDCCT - 2.15) * 10.929;

    var bgValues = daysRecords.map(function(r) { return r.sgv; });
    var quartiles = ss.quantile(bgValues, [0.25, 0.5, 0.75]);

    var lowPct = Math.round((100 * stats.lows) / daysRecords.length);
    var normalPct = Math.round((100 * stats.normal) / daysRecords.length);
    var highPct = Math.round((100 * stats.highs) / daysRecords.length);
    charts.push({host: $('<td class="daily-stats-chart">').appendTo(tr), bands: [
      {label: translate('Low'), color: '#ff5959', value: stats.lows, percent: lowPct},
      {label: translate('In Range'), color: '#4caf50', value: stats.normal, percent: normalPct},
      {label: translate('High'), color: '#ffe358', value: stats.highs, percent: highPct}
    ]});

    $('<td class="tdborder dailystats-date">' + report_plugins.utils.localeDate(day) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + Math.round((100 * stats.lows) / daysRecords.length) + '%</td>').appendTo(tr);
    $('<td class="tdborder">' + Math.round((100 * stats.normal) / daysRecords.length) + '%</td>').appendTo(tr);
    $('<td class="tdborder">' + Math.round((100 * stats.highs) / daysRecords.length) + '%</td>').appendTo(tr);
    $('<td class="tdborder">' + daysRecords.length + '</td>').appendTo(tr);
    $('<td class="tdborder">' + minForDay + '</td>').appendTo(tr);
    $('<td class="tdborder">' + maxForDay + '</td>').appendTo(tr);
    $('<td class="tdborder">' + average.toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + ss.standard_deviation(bgValues).toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + quartiles[0].toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + quartiles[1].toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + quartiles[2].toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + averageA1cDCCT.toFixed(1) + '%</td>').appendTo(tr);
    $('<td class="tdborder">' + averageA1cIFCC.toFixed(0) + '</td>').appendTo(tr);

    table.append(tr);
  });

  renderCharts();

  function renderCharts () {
    charts.forEach(function (chart) {
      chart.host.empty();
      if (selectedStyle === 'pie') {
        chartStyle.pie(chart.host[0], chart.bands, 52, translate('Glucose distribution'), false);
      } else {
        var bar = $('<div class="tir-bar">').attr('title', chart.bands.map(function (band) {
          return band.label + ': ' + band.percent + '%';
        }).join(', ')).appendTo(chart.host);
        chart.bands.forEach(function (band) {
          $('<div class="tir-seg">').css({width: band.percent + '%', background: band.color}).appendTo(bar);
        });
      }
    });
  }

  setTimeout(function() {
    todo.forEach(function(fn) {
      fn();
    });
  }, 50);
};
