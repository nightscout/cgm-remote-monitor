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
  '#dailystats-placeholder .tdborder {' +
  '  width:80px;' +
  '  border: 1px #ccc solid;' +
  '  margin: 0;' +
  '  padding: 1px;' +
  '  text-align:center;' +
  '}' +
  '#dailystats-placeholder .inlinepiechart {' +
  '  width: 2.0in;' +
  '  height: 0.9in;' +
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
  $('<th style="background-color:#f2957d">' + translate('Low') + '<br />&nbsp;</th>').appendTo(thead);
  if (options.superLow < options.targetLow) {
    $('<th style="background-color:#dfffb2">' + translate('Lowish') + '<font size="-1"><br/><div style="float:left;">&nbsp;' + options.superLow + '</div></font></th>').appendTo(thead);
  }
    $('<th style="background-color:#54c954">' + translate('In Range') + '<font size="-1"><br/><div style="float:left;">&nbsp;' + options.targetLow + '</div><div style="float:right;">' + options.targetHigh + '&nbsp;</div></font></th>').appendTo(thead);
  if (options.targetHigh < options.superHigh) {
    $('<th style="background-color:#7df27d">' + translate('Highish') + '<font size="-1"><br/><div style="float:right;">' + options.superHigh + '&nbsp;</div></font></th>').appendTo(thead);
  }
  $('<th style="background-color:#54ffff">' + translate('High') + '<br />&nbsp;</th>').appendTo(thead);
  $('<th>' + translate('Readings') + '</th>').appendTo(thead);
  $('<th>' + translate('Min') + '</th>').appendTo(thead);
  $('<th>' + translate('Max') + '</th>').appendTo(thead);
  $('<th>' + translate('Average') + '</th>').appendTo(thead);
  $('<th>' + translate('StDev') + ' (' + translate('CV') + ')</th>').appendTo(thead);
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
      if (record.sgv < options.superLow) {
        out.lows++;
      } else if (record.sgv < options.targetLow) {
        out.lowish++;
      } else if (record.sgv <= options.targetHigh) {
        out.normal++;
      } else if (record.sgv <= options.superHigh) {
        out.highish++;
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
      , lowish: 0
      , normal: 0
      , highish: 0
      , highs: 0
    });
    var average = sum / daysRecords.length;
    var averageA1cDCCT = (average * consts.MMOL_TO_MGDL + 46.7) / 28.7;
    var averageA1cIFCC = ((average * consts.MMOL_TO_MGDL + 46.7) / 28.7 - 2.15) * 10.929;

    var bgValues = daysRecords.map(function(r) { return r.sgv; });
    $('<td><div id="dailystat-chart-' + day.toString() + '" class="inlinepiechart"></div></td>').appendTo(tr);

    $('<td class="tdborder" style="width:160px">' + report_plugins.utils.localeDate(day) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + ((100.0 * stats.lows) / daysRecords.length).toFixed(1) + '%</td>').appendTo(tr);
    if (options.superLow < options.targetLow) {
      $('<td class="tdborder">' + ((100.0 * stats.lowish) / daysRecords.length).toFixed(1) + '%</td>').appendTo(tr);
    }
    $('<td class="tdborder">' + ((100.0 * stats.normal) / daysRecords.length).toFixed(1) + '%</td>').appendTo(tr);
    if (options.targetHigh < options.superHigh) {
      $('<td class="tdborder">' + ((100.0 * stats.highish) / daysRecords.length).toFixed(1) + '%</td>').appendTo(tr);
    }
    $('<td class="tdborder">' + ((100.0 * stats.highs) / daysRecords.length).toFixed(1) + '%</td>').appendTo(tr);
    $('<td class="tdborder">' + daysRecords.length + '</td>').appendTo(tr);
    $('<td class="tdborder">' + minForDay + '</td>').appendTo(tr);
    $('<td class="tdborder">' + maxForDay + '</td>').appendTo(tr);
    $('<td class="tdborder">' + average.toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + ss.standard_deviation(bgValues).toFixed(1) + '<br/>(' +
      Math.round(100 * ss.standard_deviation(bgValues) / average).toFixed(0) + '%)</td>').appendTo(tr);
    $('<td class="tdborder">' + ss.quantile(bgValues, 0.25).toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + ss.quantile(bgValues, 0.5).toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + ss.quantile(bgValues, 0.75).toFixed(1) + '</td>').appendTo(tr);
    $('<td class="tdborder">' + averageA1cDCCT.toFixed(1) + '%</td>').appendTo(tr);
    $('<td class="tdborder">' + averageA1cIFCC.toFixed(0) + '</td>').appendTo(tr);

    table.append(tr);
    var inrange = [{
      data: Math.round(stats.lows * 1000 / daysRecords.length) / 10
    }];
    var rangecolors = [ '#f2957d' ];
    if (options.superLow < options.targetLow) {
      inrange.push({
        data: Math.round(stats.lowish * 1000 / daysRecords.length) / 10
      });
      rangecolors.push('#dfffb2');
    }
    inrange.push({
      data: Math.round(stats.normal * 1000 / daysRecords.length) / 10
    });
    rangecolors.push('#54c954');
    if (options.targetHigh < options.superHigh) {
      inrange.push({
        data: Math.round(stats.highish * 1000 / daysRecords.length) / 10
      });
      rangecolors.push('#7df27d');
    }
    inrange.push({
      data: Math.round(stats.highs * 1000 / daysRecords.length) / 10
    });
    rangecolors.push('#54ffff');

    $.plot(
      '#dailystat-chart-' + day.toString()
      , inrange, {
        series: {
          pie: {
            show: true
          }
        }
        , colors: rangecolors
      }
    );
  });

  setTimeout(function() {
    todo.forEach(function(fn) {
      fn();
    });
  }, 50);
};
