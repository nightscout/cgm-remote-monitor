'use strict';

const d3 = (global && global.d3) || require('d3');
const times = require('../times');

const hourlystats = {
  name: 'hourlystats'
  , label: 'Hourly stats'
  , pluginType: 'report'
};

function init () {
  return hourlystats;
}

module.exports = init;

hourlystats.html = function html (client) {
  const translate = client.translate;
  return `<h2>${translate('Hourly stats')}</h2>
<div id="hourlystats-overviewchart"></div>
<div id="hourlystats-report"></div>`;
};

hourlystats.report = function report_hourlystats (datastorage, sorteddaystoshow, options) {
  //console.log(window);
  const ss = require('simple-statistics');
  const Nightscout = window.Nightscout;
  const client = Nightscout.client;
  const translate = client.translate;
  const report_plugins = Nightscout.report_plugins;
  const moment = window.moment;
  const profile = client.sbx.data.profile;

  const report = $('#hourlystats-report');
  const stats = [];
  const pivotedByHour = {};

  let data = datastorage.allstatsrecords;

  profile.loadData(datastorage.profiles);
  profile.updateTreatments(datastorage.profileSwitchTreatments, datastorage.tempbasalTreatments, datastorage.combobolusTreatments);

  function calculateHourlyNetBasal (day) {
    const positiveByHour = Array(24).fill(0);
    const negativeByHour = Array(24).fill(0);
    const from = profile.parseInTimezone(day);
    const to = moment(from.clone()).add(1, 'days');

    for (const dt = moment(from); dt < to; dt.add(5, 'minutes')) {
      const basal = profile.getTempBasal(dt.format('x'));
      if (!basal) continue;

      const tempPart = (basal.tempbasal - basal.basal) * 5 / 60;
      if (tempPart > 0) positiveByHour[dt.hour()] += tempPart;
      if (tempPart < 0) negativeByHour[dt.hour()] += tempPart;
    }

    return { positive: positiveByHour, negative: negativeByHour };
  }

  for (let i = 0; i < 24; i++) {
    pivotedByHour[i] = [];
  }

  data = data.filter(function(o) { return !isNaN(o.sgv); });

  data.forEach(function(record) {

    const d = profile.applyTimezone(moment(record.displayTime));
    record.sgv = Number(record.sgv);
    pivotedByHour[d.hour()].push(record);
  });

  let table = $('<table class="hourly-stats-table hourly-summary-table">');
  let thead = $('<tr class="hourly-stats-header">');
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

  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].forEach(function(hour) {
    const tr = $('<tr>');
    const display = new Date(0, 0, 1, hour, 0, 0, 0).toLocaleTimeString().replace(/([\d]+:[\d]{2})(:[\d]{2})(.*)/, '$1$3');

    const avg = Math.floor(pivotedByHour[hour].map(function(r) {
      return r.sgv;
    }).reduce(function(o, v) {
      return o + v;
    }, 0) / pivotedByHour[hour].length);
    const d = new Date(times.hours(hour).msecs);

    const dev = ss.standard_deviation(pivotedByHour[hour].map(function(r) {
      return r.sgv;
    }));
    stats.push([
      new Date(d)
      
      , ss.quantile(pivotedByHour[hour].map(function(r) {
        return r.sgv;
      }), 0.25)
      
      , ss.quantile(pivotedByHour[hour].map(function(r) {
        return r.sgv;
      }), 0.75)
      
      , avg - dev
      
      , avg + dev
    ]);
    let tmp;
    $('<td>' + display + '</td>').appendTo(tr);
    $('<td>' + pivotedByHour[hour].length + ' (' + Math.floor(100 * pivotedByHour[hour].length / data.length) + '%)</td>').appendTo(tr);
    $('<td>' + avg + '</td>').appendTo(tr);
    $('<td>' + Math.min.apply(Math, pivotedByHour[hour].map(function(r) {
      return r.sgv;
    })) + '</td>').appendTo(tr);
    // eslint-disable-next-line no-cond-assign
    $('<td>' + ((tmp = ss.quantile(pivotedByHour[hour].map(function(r) {
      return r.sgv;
    }), 0.25)) ? tmp.toFixed(1) : 0) + '</td>').appendTo(tr);
    // eslint-disable-next-line no-cond-assign
    $('<td>' + ((tmp = ss.quantile(pivotedByHour[hour].map(function(r) {
      return r.sgv;
    }), 0.5)) ? tmp.toFixed(1) : 0) + '</td>').appendTo(tr);
    // eslint-disable-next-line no-cond-assign
    $('<td>' + ((tmp = ss.quantile(pivotedByHour[hour].map(function(r) {
      return r.sgv;
    }), 0.75)) ? tmp.toFixed(1) : 0) + '</td>').appendTo(tr);
    $('<td>' + Math.max.apply(Math, pivotedByHour[hour].map(function(r) {
      return r.sgv;
    })) + '</td>').appendTo(tr);
    $('<td>' + Math.floor(dev * 10) / 10 + '</td>').appendTo(tr);
    table.append(tr);
  });

  report.empty();
  report.append(table);

  const reportStyle = window.getComputedStyle(document.documentElement);

  function themeColor (name, fallback) {
    return reportStyle.getPropertyValue(name).trim() || fallback;
  }

  const gridColor = themeColor('--report-grid', '#858585');
  const chartBackground = themeColor('--report-chart-background', '#f5f5f5');
  const candleUpColor = themeColor('--report-candle-up', '#2e7d32');
  const candleDownColor = themeColor('--report-candle-down', '#c62828');
  const candleStrokeColor = themeColor('--report-candle-stroke', '#111');

  const chartContainer = document.getElementById('hourlystats-overviewchart');
  const width = chartContainer.clientWidth || 800;
  const height = chartContainer.clientHeight || 480;
  const margin = { top: 20, right: 20, bottom: 40, left: 55 };
  const innerWidth = Math.max(100, width - margin.left - margin.right);
  const innerHeight = Math.max(100, height - margin.top - margin.bottom);
  const candleWidth = innerWidth / 24 * 0.8;
  const chartData = stats.filter(function(stat) {
    return stat.slice(1).every(function(value) {
      return isFinite(value);
    });
  });
  const xScale = d3.scaleLinear().domain([0, 24]).range([0, innerWidth]);
  const yScale = d3.scaleLinear()
    .domain([0, options.units === 'mmol' ? 22 : 400])
    .range([innerHeight, 0]);
  const xTicks = d3.range(0, 25, 2);
  const yTicks = yScale.ticks(8);

  const svg = d3.select(chartContainer)
    .html('')
    .append('svg')
    .attr('class', 'hourlystats-chart')
    .attr('viewBox', '0 0 ' + width + ' ' + height)
    .attr('preserveAspectRatio', 'xMidYMid meet');
  const chart = svg.append('g')
    .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

  chart.append('rect')
    .attr('width', innerWidth)
    .attr('height', innerHeight)
    .attr('fill', chartBackground)
    .attr('stroke', gridColor);

  chart.append('g')
    .attr('class', 'hourlystats-grid hourlystats-grid-y')
    .selectAll('line')
    .data(yTicks)
    .enter()
    .append('line')
    .attr('x2', innerWidth)
    .attr('y1', function(tick) { return yScale(tick); })
    .attr('y2', function(tick) { return yScale(tick); })
    .attr('stroke', gridColor);

  chart.append('g')
    .attr('class', 'hourlystats-grid hourlystats-grid-x')
    .selectAll('line')
    .data(xTicks)
    .enter()
    .append('line')
    .attr('x1', function(tick) { return xScale(tick); })
    .attr('x2', function(tick) { return xScale(tick); })
    .attr('y2', innerHeight)
    .attr('stroke', gridColor);

  chart.append('g')
    .attr('class', 'hourlystats-axis hourlystats-axis-x')
    .attr('transform', 'translate(0,' + innerHeight + ')')
    .attr('color', candleStrokeColor)
    .call(d3.axisBottom(xScale)
      .tickValues(xTicks)
      .tickFormat(function(hour) { return d3.format('02d')(hour) + ':00'; }));
  chart.append('g')
    .attr('class', 'hourlystats-axis hourlystats-axis-y')
    .attr('color', candleStrokeColor)
    .call(d3.axisLeft(yScale).tickValues(yTicks));

  const candles = chart.append('g')
    .selectAll('g')
    .data(chartData)
    .enter()
    .append('g')
    .attr('class', 'hourlystats-candle')
    .attr('transform', function(stat) {
      return 'translate(' + xScale(stat[0].getTime() / times.hours(1).msecs) + ',0)';
    });

  candles.append('line')
    .attr('class', 'hourlystats-candle-whisker')
    .attr('x1', candleWidth / 2)
    .attr('x2', candleWidth / 2)
    .attr('y1', function(stat) { return yScale(stat[4]); })
    .attr('y2', function(stat) { return yScale(stat[3]); })
    .attr('stroke', candleStrokeColor);

  candles.append('rect')
    .attr('class', 'hourlystats-candle-body')
    .attr('width', candleWidth)
    .attr('y', function(stat) { return yScale(Math.max(stat[1], stat[2])); })
    .attr('height', function(stat) { return Math.abs(yScale(stat[1]) - yScale(stat[2])); })
    .attr('fill', function(stat) { return stat[1] < stat[2] ? candleUpColor : candleDownColor; })
    .attr('stroke', candleStrokeColor);

  const totalPositive = [];
  const totalNegative = [];
  const positivesCount = [];
  const negativesCount = [];
  const totalNet = [];
  let days = 0;
  table = $('<table class="hourly-stats-table hourly-basal-table">');
  thead = $('<tr class="hourly-stats-header">');
  ["", 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].forEach(function(hour) {
    $('<th>' + hour + '</th>').appendTo(thead);
    totalPositive[hour] = 0;
    totalNegative[hour] = 0;
    positivesCount[hour] = 0;
    negativesCount[hour] = 0;
    totalNet[hour] = 0;
  });
  thead.appendTo(table);

  sorteddaystoshow.forEach(function(day) {
    if (datastorage[day]) {
      const hourlyNetBasal = calculateHourlyNetBasal(day);
      days++;
      const tr = $('<tr>');
      $('<td>' + report_plugins.utils.localeDate(day) + '</td>').appendTo(tr);
      for (let h = 0; h < 24; h++) {
        const positive = hourlyNetBasal.positive[h];
        const negative = hourlyNetBasal.negative[h];
        const net = positive + negative;
        totalPositive[h] += positive;
        totalNegative[h] += negative;
        if (positive + negative > 0) positivesCount[h] += 1;
        else if (positive + negative < 0) negativesCount[h] += 1;
        totalNet[h] += net;
        const netClass = Math.abs(net) < 0.019 ? 'net-neutral' : (net < 0 ? 'net-negative' : 'net-positive');
        $('<td>' +
          '<span class="basal-value">' + negative.toFixed(2) + '</span>' + '<br>' +
          '<span class="basal-value">' + positive.toFixed(2) + '</span>' + '<br>' +
          '<span class="net-basal ' + netClass + '">' + net.toFixed(2) + '</span>' +
          '</td>').appendTo(tr);
      }
      table.append(tr);
    }
  });
  if (days > 0) {
    const tr = $('<tr>');
    $('<td><span class="average-label">' + translate('Average') + " " + days + " " + translate('days') + '</span></td>').appendTo(tr);
    for (let h = 0; h < 24; h++) {
      const averageClass = Math.abs(totalNet[h]) < 0.01 ? 'net-neutral' : (totalNet[h] < 0 ? 'net-negative' : 'net-positive');
      $('<td class="net-basal-average ' + averageClass + '">' +
        '<span class="basal-value">' + (totalNegative[h] / days).toFixed(2) + ' (' + negativesCount[h] + ')' + '</span>' + '<br>' +
        '<span class="basal-value">' + (totalPositive[h] / days).toFixed(2) + ' (' + positivesCount[h] + ')' + '</span>' + '<br>' +
        '<span class="net-basal">' + (totalNet[h] / days).toFixed(2) + '</span>' +
        '</td>').appendTo(tr);
    }
    table.append(tr);
  }

  report.append('<br>');
  report.append('<h2>' + translate('Net basal stats') + '</h2>');
  report.append(table);
};
