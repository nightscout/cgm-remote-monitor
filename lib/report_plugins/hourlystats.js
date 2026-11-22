'use strict';

var times = require('../times');

var hourlystats = {
  name: 'hourlystats'
  , label: 'Hourly stats'
  , pluginType: 'report'
};

function init () {
  return hourlystats;
}

module.exports = init;

hourlystats.html = function html (client) {
  var translate = client.translate;
  var ret =
    '<h2>' + translate('Hourly stats') + '</h2>' +
    '<div id="hourlystats-overviewchart"></div>' +
    '<div id="hourlystats-report"></div>';
  return ret;
};

hourlystats.report = function report_hourlystats (datastorage, sorteddaystoshow, options) {
  //console.log(window);
  var ss = require('../report/statistics');
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var report_plugins = Nightscout.report_plugins;
  var moment = window.moment;
  var profile = client.sbx.data.profile;
  var calculateBasal = require('../report/basal-adjustments').prepare(profile, datastorage, moment).calculate;

  var report = $('#hourlystats-report');
  var stats = [];
  var pivotedByHour = {};

  var data = datastorage.allstatsrecords;

  for (var i = 0; i < 24; i++) {
    pivotedByHour[i] = [];
  }

  data = data.filter(function(o) { return !isNaN(o.sgv); });

  data.forEach(function(record) {

    var d = profile.applyTimezone(moment(record.displayTime));
    record.sgv = Number(record.sgv);
    pivotedByHour[d.hour()].push(record);
  });

  var table = $('<table class="report-bordered-table hourlystats-table">');
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

  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].forEach(function(hour) {
    var tr = $('<tr>');
    var display = new Date(0, 0, 1, hour, 0, 0, 0).toLocaleTimeString().replace(/([\d]+:[\d]{2})(:[\d]{2})(.*)/, '$1$3');

    var values = pivotedByHour[hour].map(function(r) { return r.sgv; });
    var quartiles = ss.quantile(values, [0.25, 0.5, 0.75]) || [null, null, null];
    var avg = Math.floor(values.reduce(function(o, v) { return o + v; }, 0) / values.length);
    var d = new Date(times.hours(hour).msecs);
    var dev = ss.standard_deviation(values);
    var whiskers = ss.quantile(values, [0.1, 0.9]) || [null, null];
    stats.push([new Date(d), quartiles[0], quartiles[2], whiskers[0], whiskers[1], hour, quartiles[1], Math.min.apply(Math, values), Math.max.apply(Math, values), values.length]);
    var tmp;
    $('<td>' + display + '</td>').appendTo(tr);
    $('<td>' + pivotedByHour[hour].length + ' (' + Math.floor(100 * pivotedByHour[hour].length / data.length) + '%)</td>').appendTo(tr);
    $('<td>' + avg + '</td>').appendTo(tr);
    $('<td>' + Math.min.apply(Math, values) + '</td>').appendTo(tr);
    // eslint-disable-next-line no-cond-assign
    $('<td>' + ((tmp = quartiles[0]) ? tmp.toFixed(1) : 0) + '</td>').appendTo(tr);
    // eslint-disable-next-line no-cond-assign
    $('<td>' + ((tmp = quartiles[1]) ? tmp.toFixed(1) : 0) + '</td>').appendTo(tr);
    // eslint-disable-next-line no-cond-assign
    $('<td>' + ((tmp = quartiles[2]) ? tmp.toFixed(1) : 0) + '</td>').appendTo(tr);
    $('<td>' + Math.max.apply(Math, values) + '</td>').appendTo(tr);
    $('<td>' + Math.floor(dev * 10) / 10 + '</td>').appendTo(tr);
    table.append(tr);
  });

  report.empty();
  report.append(table);

  // Modern D3 v7 per-hour box-and-whisker chart (replaces the legacy Flot
  // candlestick). Each hour: box from Q1 to Q3, median line, and whiskers to
  // the 10th/90th percentile. Percentile whiskers are always at or beyond the
  // box edges (p10 <= Q1, p90 >= Q3), unlike the old candlestick's mean +/- SD
  // "wicks" which could fall inside the interquartile box.
  var d3 = (global && global.d3) || require('../d3.mjs');
  var plainAxis = require('../report/plain-axis');

  var overview = $('#hourlystats-overviewchart');
  overview.empty();

  var hasTarget = typeof options.targetLow === 'number'
    && typeof options.targetHigh === 'number'
    && !isNaN(options.targetLow)
    && !isNaN(options.targetHigh);

  // Classify the box by where the median sits relative to target, if known;
  // the colours for each range live in report.css.
  var boxRangeFor = function boxRangeFor (median) {
    if (!hasTarget || median === undefined || median === null || isNaN(median)) {
      return 'neutral';
    }
    if (median < options.targetLow) {
      return 'low';
    }
    if (median >= options.targetHigh) {
      return 'high';
    }
    return 'inrange';
  };

  // Responsive width; sensible fixed height (~5in).
  var containerWidth = overview.width() || overview.parent().width() || 720;
  if (!containerWidth || containerWidth < 320) containerWidth = 720;
  var totalWidth = Math.round(containerWidth)
    , totalHeight = 480
    , margin = { top: 16, right: 20, bottom: 36, left: 48 }
    , chartWidth = totalWidth - margin.left - margin.right
    , chartHeight = totalHeight - margin.top - margin.bottom;

  var yMax = options.units === 'mmol' ? 22 : 400;

  var xScale = d3.scaleBand()
    .domain(d3.range(0, 24))
    .rangeRound([0, chartWidth])
    .paddingInner(0.35)
    .paddingOuter(0.2);

  var yScale = d3.scaleLinear()
    .domain([0, yMax])
    .rangeRound([chartHeight, 0]);

  var svg = d3.select('#hourlystats-overviewchart')
    .append('svg')
    .attr('width', totalWidth)
    .attr('height', totalHeight)
    .attr('viewBox', '0 0 ' + totalWidth + ' ' + totalHeight)
    .attr('preserveAspectRatio', 'xMidYMid meet');

  // white background for the (light) reports page
  svg.append('rect')
    .attr('class', 'daily-chart-background')
    .attr('width', totalWidth)
    .attr('height', totalHeight);

  var g = svg.append('g')
    .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

  // horizontal gridlines
  g.append('g')
    .attr('class', 'hs-grid')
    .call(d3.axisLeft(yScale).offset(0)
      .ticks(8)
      .tickSize(-chartWidth)
      .tickFormat('')).call(plainAxis, 'left');

  // y axis
  g.append('g')
    .attr('class', 'hs-axis')
    .call(d3.axisLeft(yScale).offset(0).ticks(8)).call(plainAxis, 'left');

  // x axis -- label every 3 hours, ticks for each hour
  g.append('g')
    .attr('class', 'hs-axis')
    .attr('transform', 'translate(0,' + chartHeight + ')')
    .call(d3.axisBottom(xScale).offset(0)
      .tickFormat(function(h) {
        return (h % 3 === 0) ? (h + ':00') : '';
      })).call(plainAxis, 'bottom');

  // axis labels
  g.append('text')
    .attr('class', 'hs-axis-label')
    .attr('x', Math.round(chartWidth / 2))
    .attr('y', chartHeight + margin.bottom - 2)
    .text(translate('Time'));

  // tooltip, positioned inside the chart container (emptied on every run)
  var tooltip = d3.select(overview[0]).append('div')
    .attr('class', 'hourlystats-tooltip');

  stats.forEach(function(s) {
    var hour = s[5]
      , q1 = s[1]
      , q3 = s[2]
      , whiskerLow = Math.max(0, s[3])
      , whiskerHigh = s[4]
      , median = s[6]
      , minVal = s[7]
      , maxVal = s[8]
      , count = s[9];

    if (!count) return; // skip empty hours

    var bx = xScale(hour)
      , bw = xScale.bandwidth()
      , cx = bx + Math.round(bw / 2)
      , capHalfWidth = Math.round(bw / 4);

    var hourG = g.append('g').attr('class', 'hs-hour hs-range-' + boxRangeFor(median));

    // whisker vertical line (std-dev range)
    hourG.append('line')
      .attr('class', 'hs-whisker')
      .attr('x1', cx)
      .attr('x2', cx)
      .attr('y1', yScale(whiskerHigh))
      .attr('y2', yScale(whiskerLow));

    // whisker caps
    hourG.append('line')
      .attr('class', 'hs-whisker')
      .attr('x1', cx - capHalfWidth)
      .attr('x2', cx + capHalfWidth)
      .attr('y1', yScale(whiskerHigh))
      .attr('y2', yScale(whiskerHigh));
    hourG.append('line')
      .attr('class', 'hs-whisker')
      .attr('x1', cx - capHalfWidth)
      .attr('x2', cx + capHalfWidth)
      .attr('y1', yScale(whiskerLow))
      .attr('y2', yScale(whiskerLow));

    // box Q1 .. Q3
    var boxTop = Math.min(yScale(q1), yScale(q3))
      , boxHeight = Math.max(1, Math.abs(yScale(q1) - yScale(q3)));
    hourG.append('rect')
      .attr('x', bx)
      .attr('y', boxTop)
      .attr('width', bw)
      .attr('height', boxHeight)
      .attr('class', 'hs-box');

    // median line
    if (median !== undefined && median !== null && !isNaN(median)) {
      hourG.append('line')
        .attr('class', 'hs-median')
        .attr('x1', bx)
        .attr('x2', bx + bw)
        .attr('y1', yScale(median))
        .attr('y2', yScale(median));
    }

    // transparent hover target spanning the band
    var fmt = function(v) {
      return (v === undefined || v === null || isNaN(v)) ? '-' : Number(v).toFixed(1);
    };
    hourG.append('rect')
      .attr('class', 'percentile-hover-target')
      .attr('x', bx)
      .attr('y', 0)
      .attr('width', bw)
      .attr('height', chartHeight)
      .on('mouseover', function() {
        tooltip.style('display', 'block')
          .html('<strong>' + hour + ':00</strong><br/>'
            + translate('Max') + ': ' + fmt(maxVal) + '<br/>'
            + '90%: ' + fmt(whiskerHigh) + '<br/>'
            + translate('Quartile') + ' 75: ' + fmt(q3) + '<br/>'
            + translate('Median') + ': ' + fmt(median) + '<br/>'
            + translate('Quartile') + ' 25: ' + fmt(q1) + '<br/>'
            + '10%: ' + fmt(whiskerLow) + '<br/>'
            + translate('Min') + ': ' + fmt(minVal));
      })
      .on('mousemove', function(event) {
        var box = overview[0].getBoundingClientRect()
          , x = Math.round(((event && event.clientX) || 0) - box.left)
          , y = Math.round(((event && event.clientY) || 0) - box.top)
          , width = tooltip.node().offsetWidth
          // show it left of the pointer when it would run past the right edge
          , left = x + 12 + width > box.width ? x - width - 12 : x + 12;
        tooltip.style('left', Math.max(0, left) + 'px')
          .style('top', Math.max(0, y - 12) + 'px');
      })
      .on('mouseout', function() {
        tooltip.style('display', 'none');
      });
  });

  require('../report/hourly-basal')(report, datastorage, sorteddaystoshow, client, report_plugins.utils.localeDate, calculateBasal);

};
