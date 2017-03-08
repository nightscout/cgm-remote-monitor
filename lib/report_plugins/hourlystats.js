'use strict';

var times = require('../times');

var hourlystats = {
  name: 'hourlystats'
  , label: 'Hourly stats'
  , pluginType: 'report'
};

function init() {
  return hourlystats;
}

module.exports = init;

hourlystats.html = function html(client) {
  var translate = client.translate;
  var ret =
      '<h2>' + translate('Hourly stats') + '</h2>'
      + '<div id="hourlystats-overviewchart"></div>'
      + '<div id="hourlystats-report"></div>'
    ;
  return ret;
};

hourlystats.css =
  '#hourlystats-overviewchart {'
  + '  width: 100%;'
  + '  min-width: 6.5in;'
  + '  height: 5in;'
  + '}'
  + '#hourlystats-placeholder td {'
  + '  text-align:center;'
  + '}';

hourlystats.report = function report_hourlystats(datastorage, sorteddaystoshow, options) {
//console.log(window);
  var ss = require('simple-statistics');
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var report_plugins = Nightscout.report_plugins;

  var report = $('#hourlystats-report');
  var stats = [];
  var pivotedByHour = {};

  var data = datastorage.allstatsrecords;

  for (var i = 0; i < 24; i++) {
    pivotedByHour[i] = [];
  }
  data.forEach(function (record) {
    var d = new Date(record.displayTime);
    pivotedByHour[d.getHours()].push(record);
  });
  var table = $('<table width="100%" border="1">');
  var thead = $('<tr/>');
  $('<th>' + translate('Time') + '</th>').appendTo(thead);
  $('<th>' + translate('Readings') + '</th>').appendTo(thead);
  $('<th>' + translate('Average') + '</th>').appendTo(thead);
  $('<th>' + translate('Min') + '</th>').appendTo(thead);
  $('<th>' + translate('Quartile') + ' 25</th>').appendTo(thead);
  $('<th>' + translate('Median') + '</th>').appendTo(thead);
  $('<th>' + translate('Quartile') + ' 75</th>').appendTo(thead);
  $('<th>' + translate('Max') + '</th>').appendTo(thead);
  $('<th>' + translate('Standard Deviation') + '</th>').appendTo(thead);
  thead.appendTo(table);

  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].forEach(function (hour) {
    var tr = $('<tr>');
    var display = new Date(0, 0, 1, hour, 0, 0, 0).toLocaleTimeString().replace(/([\d]+:[\d]{2})(:[\d]{2})(.*)/, '$1$3');

    var avg = Math.floor(pivotedByHour[hour].map(function (r) {
        return r.sgv;
      }).reduce(function (o, v) {
        return o + v;
      }, 0) / pivotedByHour[hour].length);
    var d = new Date(times.hours(hour).msecs);

    var dev = ss.standard_deviation(pivotedByHour[hour].map(function (r) {
      return r.sgv;
    }));
    stats.push([
      new Date(d),
      ss.quantile(pivotedByHour[hour].map(function (r) {
        return r.sgv;
      }), 0.25),
      ss.quantile(pivotedByHour[hour].map(function (r) {
        return r.sgv;
      }), 0.75),
      avg - dev,
      avg + dev
    ]);
    var tmp;
    $('<td>' + display + '</td>').appendTo(tr);
    $('<td>' + pivotedByHour[hour].length + ' (' + Math.floor(100 * pivotedByHour[hour].length / data.length) + '%)</td>').appendTo(tr);
    $('<td>' + avg + '</td>').appendTo(tr);
    $('<td>' + Math.min.apply(Math, pivotedByHour[hour].map(function (r) {
        return r.sgv;
      })) + '</td>').appendTo(tr);
    $('<td>' + ((tmp = ss.quantile(pivotedByHour[hour].map(function (r) {
        return r.sgv;
      }), 0.25)) ? tmp.toFixed(1) : 0 ) + '</td>').appendTo(tr);
    $('<td>' + ((tmp = ss.quantile(pivotedByHour[hour].map(function (r) {
        return r.sgv;
      }), 0.5)) ? tmp.toFixed(1) : 0 ) + '</td>').appendTo(tr);
    $('<td>' + ((tmp = ss.quantile(pivotedByHour[hour].map(function (r) {
        return r.sgv;
      }), 0.75)) ? tmp.toFixed(1) : 0 ) + '</td>').appendTo(tr);
    $('<td>' + Math.max.apply(Math, pivotedByHour[hour].map(function (r) {
        return r.sgv;
      })) + '</td>').appendTo(tr);
    $('<td>' + Math.floor(dev * 10) / 10 + '</td>').appendTo(tr);
    table.append(tr);
  });

  report.empty();
  report.append(table);

  $.plot(
    '#hourlystats-overviewchart',
    [{
      data: stats,
      candle: true
    }],
    {
      series: {
        candle: true,
        lines: false    //Somehow it draws lines if you dont disable this. Should investigate and fix this ;)
      },
      xaxis: {
        mode: 'time',
        timeFormat: '%h:00',
        min: 0,
        max: times.hours(24).msecs - times.secs(1).msecs
      },
      yaxis: {
        min: 0,
        max: options.units === 'mmol' ? 22 : 400,
        show: true
      },
      grid: {
        show: true
      }
    }
  );

  var totalPositive = [];
  var totalNegative = [];
  var totalNet = [];
  var days = 0;
  table = $('<table width="100%" border="1">');
  thead = $('<tr/>');
  ["", 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].forEach(function (hour) {
    $('<th>' + hour + '</th>').appendTo(thead);
    totalPositive[hour] = 0;
    totalNegative[hour] = 0;
    totalNet[hour] = 0;
  });
  thead.appendTo(table);

  sorteddaystoshow.forEach(function (day) {
    if (datastorage[day].netBasalPositive) {
      days++;
      var tr = $('<tr>');
      $('<td>' + report_plugins.utils.localeDate(day) + '</td>').appendTo(tr);
      for (var h = 0; h < 24; h++) {
        var positive = datastorage[day].netBasalPositive[h];
        var negative = datastorage[day].netBasalNegative[h];
        var net = positive + negative;
        totalPositive[h] += positive;
        totalNegative[h] += negative;
        totalNet[h] += net;
        var color = Math.abs(net) < 0.019 ? "black" : (net < 0 ? "red" : "lightgreen");
        $('<td>' +
          '<span style="color:black;">' + negative.toFixed(2) + '</span>' + '<br>' +
          '<span style="color:black;">' + positive.toFixed(2) + '</span>' + '<br>' +
          '<span style="color:' + color + ';font-weight:bold;">' + net.toFixed(2) + '</span>' +
          '</td>').appendTo(tr);
      }
      table.append(tr);
    }
  });
  if (days > 0) {
    var tr = $('<tr>');
    $('<td>' + '<span style="font-weight:bold;">' + translate('Average') + " " + days + " " + translate('days') + '</span>' + '</td>').appendTo(tr);
    for (var h = 0; h < 24; h++) {
      var color = Math.abs(totalNet[h]) < 0.01 ? "white" : (totalNet[h] < 0 ? "red" : "lightgreen");
      $('<td style="background-color:' + color + '";>' +
        '<span style="color:black;">' + (totalNegative[h] / days).toFixed(2) + '</span>' + '<br>' +
        '<span style="color:black;">' + (totalPositive[h] / days).toFixed(2) + '</span>' + '<br>' +
        '<span style="color:black;font-weight:bold;">' + (totalNet[h] / days).toFixed(2) + '</span>' +
        '</td>').appendTo(tr);
    }
    table.append(tr);
  }

  report.append('<br>');
  report.append('<h2>' + translate('netIOB stats') + '</h2>');
  report.append(translate('(temp basals must be rendered to display this report)'));
  report.append('<br><br>');
  report.append(table);
};
