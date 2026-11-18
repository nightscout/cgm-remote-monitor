'use strict';

const d3 = (global && global.d3) || require('d3');

const dailystats = {
  name: 'dailystats'
  , label: 'Daily Stats'
  , pluginType: 'report'
};

function init () {
  return dailystats;
}

module.exports = init;

dailystats.html = function html (client) {
  const translate = client.translate;
  return `<h2>${translate('Daily stats report')}</h2><div id="dailystats-report"></div>`;
};

dailystats.report = function report_dailystats (datastorage, sorteddaystoshow, options) {
  const Nightscout = window.Nightscout;
  const client = Nightscout.client;
  const translate = client.translate;
  const report_plugins = Nightscout.report_plugins;

  const ss = require('simple-statistics');

  const report = $('#dailystats-report');
  let minForDay, maxForDay, sum, sumMgdl;

  report.empty();
  const legend = $('<div>').addClass('dailystats-legend');
  [
    { label: translate('Low'), className: 'dailystats-low' }
    
    , { label: translate('In Range'), className: 'dailystats-in-range' }
    
    , { label: translate('High'), className: 'dailystats-high' }
  ].forEach(function addLegendItem (item) {
    legend.append($('<span>').addClass('dailystats-legend-item')
      .append($('<span>').addClass('dailystats-legend-swatch ' + item.className))
      .append($('<span>').text(item.label)));
  });
  report.append(legend);
  const table = $('<table class="centeraligned">');
  report.append(table);
  const thead = $('<tr/>');
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
    const tr = $('<tr>');

    const daysRecords = datastorage[day].statsrecords;

    if (daysRecords.length === 0) {
      $('<td/>').appendTo(tr);
      $('<td class="tdborder date-column">' + report_plugins.utils.localeDate(day) + '</td>').appendTo(tr);
      $('<td class="tdborder" colspan="10">' + translate('No data available') + '</td>').appendTo(tr);
      table.append(tr);
      return;
    }

    minForDay = daysRecords[0].sgv;
    maxForDay = daysRecords[0].sgv;
    sum = 0;
    sumMgdl = 0;

    const stats = daysRecords.reduce(function(out, record) {
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
    const average = sum / daysRecords.length;
    // bgValue retains the original mg/dL reading; sgv is rounded in display units.
    const averageMgdl = sumMgdl / daysRecords.length;
    const averageA1cDCCT = (averageMgdl + 46.7) / 28.7;
    const averageA1cIFCC = (averageA1cDCCT - 2.15) * 10.929;

    const bgValues = daysRecords.map(function(r) {
      return r.sgv;
    });
    $('<td><div id="dailystat-chart-' + day.toString() + '" class="inlinepiechart"></div></td>').appendTo(tr);

    $('<td class="tdborder date-column">' + report_plugins.utils.localeDate(day) + '</td>').appendTo(tr);
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
    const inrange = [
      {
        label: translate('Low')
        , data: Math.round(stats.lows * 1000 / daysRecords.length) / 10
        , className: 'dailystats-low'
      }
      
      , {
        label: translate('In Range')
        , data: Math.round(stats.normal * 1000 / daysRecords.length) / 10
        , className: 'dailystats-in-range'
      }
      
      , {
        label: translate('High')
        , data: Math.round(stats.highs * 1000 / daysRecords.length) / 10
        , className: 'dailystats-high'
      }
    ];
    drawPieChart('#dailystat-chart-' + day.toString(), inrange);
  });
};

function drawPieChart (selector, data) {
  const width = 210;
  const height = 86;
  const radius = Math.min(width, height) / 2 - 3;
  const svg = d3.select(selector)
    .append('svg')
    .attr('viewBox', '0 0 ' + width + ' ' + height)
    .attr('preserveAspectRatio', 'xMidYMid meet');
  const chart = svg.append('g')
    .attr('transform', 'translate(' + width / 2 + ',' + height / 2 + ')');
  const pie = d3.pie()
    .sort(null)
    .value(function pieValue (item) {
      return item.data;
    });
  const arc = d3.arc().innerRadius(0).outerRadius(radius);

  chart.selectAll('path')
    .data(pie(data))
    .enter()
    .append('path')
    .attr('class', function pieClass (item) { return 'dailystats-pie-slice ' + item.data.className; })
    .attr('data-label', function pieLabel (item) { return item.data.label; })
    .attr('data-value', function pieValueAttribute (item) { return item.data.data; })
    .attr('d', arc)
    .append('title')
    .text(function pieTitle (item) { return item.data.label + ': ' + item.data.data + '%'; });
}
