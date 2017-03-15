'use strict';

var dailystats = {
  name: 'dailystats'
  , label: 'Daily Stats'
  , pluginType: 'report'
};

function init() {
  return dailystats;
}

module.exports = init;

dailystats.html = function html(client) {
  var translate = client.translate;
  var ret =
      '<h1>' + translate('Daily stats report') + '</h1>'
    + '<div id="dailystats-report"></div>'
    ;
  return ret;
};

dailystats.css =
    '#dailystats-placeholder .tdborder {'
  + '  width:80px;'
  + '  border: 1px #ccc solid;'
  + '  margin: 0;'
  + '  padding: 1px;'
  + '  text-align:center;'
  + '}'
  + '#dailystats-placeholder .inlinepiechart {'
  + '  width: 2.0in;'
  + '  height: 0.9in;'
  + '}'
  ;

dailystats.report = function report_dailystats(datastorage,sorteddaystoshow,options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var report_plugins = Nightscout.report_plugins;
  
  var ss = require('simple-statistics');

  var todo = [];
  var report = $('#dailystats-report');
  var minForDay, maxForDay;

  report.empty();
  var table = $('<table class="centeraligned">');
  report.append(table);
  var thead = $('<tr/>');
  $('<th></th>').appendTo(thead);
  $('<th>'+translate('Date')+'</th>').appendTo(thead);
  $('<th>'+translate('Low')+'</th>').appendTo(thead);
  $('<th>'+translate('Normal')+'</th>').appendTo(thead);
  $('<th>'+translate('High')+'</th>').appendTo(thead);
  $('<th>'+translate('Readings')+'</th>').appendTo(thead);
  $('<th>'+translate('Min')+'</th>').appendTo(thead);
  $('<th>'+translate('Max')+'</th>').appendTo(thead);
  $('<th>'+translate('StDev')+'</th>').appendTo(thead);
  $('<th>'+translate('25%')+'</th>').appendTo(thead);
  $('<th>'+translate('Median')+'</th>').appendTo(thead);
  $('<th>'+translate('75%')+'</th>').appendTo(thead);
  thead.appendTo(table);

  sorteddaystoshow.forEach(function (day) {
    var tr = $('<tr>');

    var daysRecords = datastorage[day].statsrecords;
    
    if (daysRecords.length === 0) {
      $('<td/>').appendTo(tr);
      $('<td class=\"tdborder\" style=\"width:160px\">' +  report_plugins.utils.localeDate(day) + '</td>').appendTo(tr);
      $('<td  class=\"tdborder\"colspan="10">'+translate('No data available')+'</td>').appendTo(tr);
      table.append(tr);
      return;;
    }

    minForDay = daysRecords[0].sgv;
    maxForDay = daysRecords[0].sgv;
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
      return out;
    }, {
      lows: 0,
      normal: 0,
      highs: 0
    });
    var bgValues = daysRecords.map(function(r) { return r.sgv; });
    $('<td><div id=\"dailystat-chart-' + day.toString() + '\" class=\"inlinepiechart\"></div></td>').appendTo(tr);

    $('<td class=\"tdborder\" style=\"width:160px\">' +  report_plugins.utils.localeDate(day) + '</td>').appendTo(tr);
    $('<td class=\"tdborder\">' + Math.round((100 * stats.lows) / daysRecords.length) + '%</td>').appendTo(tr);
    $('<td class=\"tdborder\">' + Math.round((100 * stats.normal) / daysRecords.length) + '%</td>').appendTo(tr);
    $('<td class=\"tdborder\">' + Math.round((100 * stats.highs) / daysRecords.length) + '%</td>').appendTo(tr);
    $('<td class=\"tdborder\">' + daysRecords.length +'</td>').appendTo(tr);
    $('<td class=\"tdborder\">' + minForDay +'</td>').appendTo(tr);
    $('<td class=\"tdborder\">' + maxForDay +'</td>').appendTo(tr);
    $('<td class=\"tdborder\">' + Math.round(ss.standard_deviation(bgValues)) + '</td>').appendTo(tr);
    $('<td class=\"tdborder\">' + ss.quantile(bgValues, 0.25).toFixed(1) + '</td>').appendTo(tr);
    $('<td class=\"tdborder\">' + ss.quantile(bgValues, 0.5).toFixed(1) + '</td>').appendTo(tr);
    $('<td class=\"tdborder\">' + ss.quantile(bgValues, 0.75).toFixed(1) + '</td>').appendTo(tr);

    table.append(tr);
    var inrange = [
      {
        label: translate('Low'),
        data: Math.round(stats.lows * 1000 / daysRecords.length) / 10
      },
      {
        label: translate('In Range'),
        data: Math.round(stats.normal * 1000 / daysRecords.length) / 10
      },
      {
        label: translate('High'),
        data: Math.round(stats.highs * 1000 / daysRecords.length) / 10
      }
    ];
    $.plot(
      '#dailystat-chart-' + day.toString(),
      inrange,
      {
        series: {
          pie: {
            show: true
          }
        },
        colors: ['#f88', '#8f8', '#ff8']
      }
    );
  });

  setTimeout(function() {
    todo.forEach(function(fn) {
      fn();
    });
  }, 50);
};
