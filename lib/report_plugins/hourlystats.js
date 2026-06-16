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

hourlystats.css =
  '#hourlystats-overviewchart {' +
  '  width: 100%;' +
  '  min-width: 6.5in;' +
  '  margin-bottom: 1em;' +
  '}' +
  '#hourlystats-overviewchart svg {' +
  '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;' +
  '  display: block;' +
  '}' +
  '#hourlystats-overviewchart .hs-grid line {' +
  '  stroke: #eceff1;' +
  '  shape-rendering: crispEdges;' +
  '}' +
  '#hourlystats-overviewchart .hs-grid path {' +
  '  stroke: none;' +
  '}' +
  '#hourlystats-overviewchart .hs-axis text {' +
  '  fill: #607d8b;' +
  '  font-size: 11px;' +
  '}' +
  '#hourlystats-overviewchart .hs-axis path,' +
  '#hourlystats-overviewchart .hs-axis line {' +
  '  stroke: #cfd8dc;' +
  '  shape-rendering: crispEdges;' +
  '}' +
  '#hourlystats-overviewchart .hs-axis-label {' +
  '  fill: #607d8b;' +
  '  font-size: 11px;' +
  '}' +
  '.hourlystats-tooltip {' +
  '  position: absolute;' +
  '  pointer-events: none;' +
  '  background: #ffffff;' +
  '  border: 1px solid #cfd8dc;' +
  '  border-radius: 4px;' +
  '  box-shadow: 0 2px 6px rgba(0,0,0,0.15);' +
  '  padding: 6px 8px;' +
  '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;' +
  '  font-size: 11px;' +
  '  color: #37474f;' +
  '  white-space: nowrap;' +
  '  z-index: 1000;' +
  '  display: none;' +
  '}' +
  '#hourlystats-placeholder td {' +
  '  text-align:center;' +
  '}';

hourlystats.report = function report_hourlystats (datastorage, sorteddaystoshow, options) {
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

  data = data.filter(function(o) { return !isNaN(o.sgv); });

  data.forEach(function(record) {

    var d = new Date(record.displayTime);
    record.sgv = Number(record.sgv);
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

  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].forEach(function(hour) {
    var tr = $('<tr>');
    var display = new Date(0, 0, 1, hour, 0, 0, 0).toLocaleTimeString().replace(/([\d]+:[\d]{2})(:[\d]{2})(.*)/, '$1$3');

    var avg = Math.floor(pivotedByHour[hour].map(function(r) {
      return r.sgv;
    }).reduce(function(o, v) {
      return o + v;
    }, 0) / pivotedByHour[hour].length);
    var d = new Date(times.hours(hour).msecs);

    var dev = ss.standard_deviation(pivotedByHour[hour].map(function(r) {
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
      , ss.quantile(pivotedByHour[hour].map(function(r) {
        return r.sgv;
      }), 0.1)
      , ss.quantile(pivotedByHour[hour].map(function(r) {
        return r.sgv;
      }), 0.9)
      , hour
      , ss.quantile(pivotedByHour[hour].map(function(r) {
        return r.sgv;
      }), 0.5)
      , Math.min.apply(Math, pivotedByHour[hour].map(function(r) {
        return r.sgv;
      }))
      , Math.max.apply(Math, pivotedByHour[hour].map(function(r) {
        return r.sgv;
      }))
      , pivotedByHour[hour].length
    ]);
    var tmp;
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

  // Modern D3 v7 per-hour box-and-whisker chart (replaces the legacy Flot
  // candlestick). Each hour: box from Q1 to Q3, median line, and whiskers to
  // the 10th/90th percentile. Percentile whiskers are always at or beyond the
  // box edges (p10 <= Q1, p90 >= Q3), unlike the old candlestick's mean +/- SD
  // "wicks" which could fall inside the interquartile box.
  var d3 = (global && global.d3) || require('d3');

  var accent = '#1f6fc4'
    , accentFill = 'rgba(31,111,196,0.18)'
    , lowColor = '#e57373'
    , inRangeColor = '#43a047'
    , highColor = '#fb8c00';

  var overview = $('#hourlystats-overviewchart');
  overview.empty();

  var hasTarget = typeof options.targetLow === 'number'
    && typeof options.targetHigh === 'number'
    && !isNaN(options.targetLow)
    && !isNaN(options.targetHigh);

  // Color the box by where the median sits relative to target, if known.
  var boxColorFor = function boxColorFor (median) {
    if (!hasTarget || median === undefined || median === null || isNaN(median)) {
      return { stroke: accent, fill: accentFill };
    }
    if (median < options.targetLow) {
      return { stroke: lowColor, fill: 'rgba(229,115,115,0.18)' };
    }
    if (median >= options.targetHigh) {
      return { stroke: highColor, fill: 'rgba(251,140,0,0.18)' };
    }
    return { stroke: inRangeColor, fill: 'rgba(67,160,71,0.18)' };
  };

  // Responsive width; sensible fixed height (~5in).
  var containerWidth = overview.width() || overview.parent().width() || 720;
  if (!containerWidth || containerWidth < 320) containerWidth = 720;
  var totalWidth = containerWidth
    , totalHeight = 480
    , margin = { top: 16, right: 20, bottom: 36, left: 48 }
    , chartWidth = totalWidth - margin.left - margin.right
    , chartHeight = totalHeight - margin.top - margin.bottom;

  var yMax = options.units === 'mmol' ? 22 : 400;

  var xScale = d3.scaleBand()
    .domain(d3.range(0, 24))
    .range([0, chartWidth])
    .paddingInner(0.35)
    .paddingOuter(0.2);

  var yScale = d3.scaleLinear()
    .domain([0, yMax])
    .range([chartHeight, 0]);

  var svg = d3.select('#hourlystats-overviewchart')
    .append('svg')
    .attr('width', totalWidth)
    .attr('height', totalHeight)
    .attr('viewBox', '0 0 ' + totalWidth + ' ' + totalHeight)
    .attr('preserveAspectRatio', 'xMidYMid meet');

  // white background for the (light) reports page
  svg.append('rect')
    .attr('width', totalWidth)
    .attr('height', totalHeight)
    .attr('fill', '#ffffff');

  var g = svg.append('g')
    .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

  // horizontal gridlines
  g.append('g')
    .attr('class', 'hs-grid')
    .call(d3.axisLeft(yScale)
      .ticks(8)
      .tickSize(-chartWidth)
      .tickFormat(''));

  // y axis
  g.append('g')
    .attr('class', 'hs-axis')
    .call(d3.axisLeft(yScale).ticks(8));

  // x axis -- label every 3 hours, ticks for each hour
  g.append('g')
    .attr('class', 'hs-axis')
    .attr('transform', 'translate(0,' + chartHeight + ')')
    .call(d3.axisBottom(xScale)
      .tickFormat(function(h) {
        return (h % 3 === 0) ? (h + ':00') : '';
      }));

  // axis labels
  g.append('text')
    .attr('class', 'hs-axis-label')
    .attr('text-anchor', 'middle')
    .attr('x', chartWidth / 2)
    .attr('y', chartHeight + margin.bottom - 2)
    .text(translate('Time'));

  // tooltip
  var tooltip = d3.select('body').append('div')
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
      , cx = bx + bw / 2;

    var colors = boxColorFor(median);

    var hourG = g.append('g').attr('class', 'hs-box');

    // whisker vertical line (std-dev range)
    hourG.append('line')
      .attr('x1', cx)
      .attr('x2', cx)
      .attr('y1', yScale(whiskerHigh))
      .attr('y2', yScale(whiskerLow))
      .attr('stroke', colors.stroke)
      .attr('stroke-width', 1.25);

    // whisker caps
    hourG.append('line')
      .attr('x1', cx - bw / 4)
      .attr('x2', cx + bw / 4)
      .attr('y1', yScale(whiskerHigh))
      .attr('y2', yScale(whiskerHigh))
      .attr('stroke', colors.stroke)
      .attr('stroke-width', 1.25);
    hourG.append('line')
      .attr('x1', cx - bw / 4)
      .attr('x2', cx + bw / 4)
      .attr('y1', yScale(whiskerLow))
      .attr('y2', yScale(whiskerLow))
      .attr('stroke', colors.stroke)
      .attr('stroke-width', 1.25);

    // box Q1 .. Q3
    var boxTop = Math.min(yScale(q1), yScale(q3))
      , boxHeight = Math.max(1, Math.abs(yScale(q1) - yScale(q3)));
    hourG.append('rect')
      .attr('x', bx)
      .attr('y', boxTop)
      .attr('width', bw)
      .attr('height', boxHeight)
      .attr('fill', colors.fill)
      .attr('stroke', colors.stroke)
      .attr('stroke-width', 1.25)
      .style('print-color-adjust', 'exact')
      .style('-webkit-print-color-adjust', 'exact');

    // median line
    if (median !== undefined && median !== null && !isNaN(median)) {
      hourG.append('line')
        .attr('x1', bx)
        .attr('x2', bx + bw)
        .attr('y1', yScale(median))
        .attr('y2', yScale(median))
        .attr('stroke', colors.stroke)
        .attr('stroke-width', 2);
    }

    // transparent hover target spanning the band
    var fmt = function(v) {
      return (v === undefined || v === null || isNaN(v)) ? '-' : Number(v).toFixed(1);
    };
    hourG.append('rect')
      .attr('x', bx)
      .attr('y', 0)
      .attr('width', bw)
      .attr('height', chartHeight)
      .attr('fill', 'transparent')
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
        var pageX = (event && event.pageX) || 0
          , pageY = (event && event.pageY) || 0;
        tooltip.style('left', (pageX + 12) + 'px')
          .style('top', (pageY - 12) + 'px');
      })
      .on('mouseout', function() {
        tooltip.style('display', 'none');
      });
  });

  var totalPositive = [];
  var totalNegative = [];
  var positivesCount = [];
  var negativesCount = [];
  var totalNet = [];
  var days = 0;
  table = $('<table width="100%" border="1">');
  thead = $('<tr/>');
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
        if (positive + negative > 0) positivesCount[h] += 1;
        else if (positive + negative < 0) negativesCount[h] += 1;
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
        '<span style="color:black;">' + (totalNegative[h] / days).toFixed(2) + ' (' + negativesCount[h] + ')' + '</span>' + '<br>' +
        '<span style="color:black;">' + (totalPositive[h] / days).toFixed(2) + ' (' + positivesCount[h] + ')' + '</span>' + '<br>' +
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
