'use strict';

var percentile = {
  name: 'percentile'
  , label: 'Percentile Chart'
  , pluginType: 'report'
};

function init() {
  return percentile;
}

module.exports = init;

percentile.html = function html(client) {
  var translate = client.translate;
  var ret =
  '<h2>'
  + translate('Glucose Percentile report')
  + ' ('
  + '<span id="percentile-days"></span>'
  + ')'
  + '</h2>'
  + '<div class="percentile-wrap">'
  + '  <div class="chart" id="percentile-chart"></div>'
  + '</div>'
  ;

  return ret;
};

percentile.css =
    '.percentile-wrap{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}'
  + '#percentile-chart{width:100%;position:relative;}'
  + '#percentile-chart svg{display:block;}'
  + '#percentile-chart svg text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}'
  + '#percentile-chart .percentile-fill{-webkit-print-color-adjust:exact;print-color-adjust:exact;}'
  + '#percentile-tooltip{position:absolute;pointer-events:none;background:rgba(38,50,56,0.92);color:#fff;'
  + 'font-size:11px;line-height:1.4;padding:6px 8px;border-radius:6px;white-space:nowrap;'
  + 'box-shadow:0 1px 4px rgba(0,0,0,0.3);opacity:0;transition:opacity 0.08s;z-index:10;}'
  + '#percentile-tooltip .percentile-tt-h{font-weight:700;margin-bottom:2px;}'
  ;

percentile.report = function report_percentile(datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var ss = require('simple-statistics');
  var d3 = (global && global.d3) || require('d3');

  var minutewindow = 30; //minute-window should be a divisor of 60

  var data = datastorage.allstatsrecords;

  var bins = [];
  var filterFunc = function withinWindow(record) {
    var recdate = new Date(record.displayTime);
    return recdate.getHours() === hour && recdate.getMinutes() >= minute && recdate.getMinutes() < minute + minutewindow;
  };

  var reportPlugins = Nightscout.report_plugins;
  var firstDay = reportPlugins.utils.localeDate(sorteddaystoshow[sorteddaystoshow.length - 1]);
  var lastDay = reportPlugins.utils.localeDate(sorteddaystoshow[0]);
  var countDays = sorteddaystoshow.length;

  $('#percentile-days').text(countDays + ' ' + translate('days total') + ', ' + firstDay + ' - ' + lastDay);

  var isMmol = options.units === 'mmol';

  function fmtVal(v) {
    if (v === null || v === undefined || isNaN(v)) { return ''; }
    return isMmol ? v.toFixed(1) : String(Math.round(v));
  }

  // Build percentile series keyed by minute-of-day at the bin center.
  // Skip empty bins so lines/bands do not dip to zero.
  var series = { p10: [], p25: [], p50: [], p75: [], p90: [] };
  for (var hour = 0; hour < 24; hour++) {
    for (var minute = 0; minute < 60; minute = minute + minutewindow) {
      var readings = data.filter(filterFunc).map(function(record) {
        return record.sgv;
      });
      if (readings.length < 1) { continue; }
      readings = readings.slice().sort(function(a, b) { return a - b; });
      var center = hour * 60 + minute + minutewindow / 2;
      series.p10.push({ t: center, v: ss.quantile(readings, 0.1) });
      series.p25.push({ t: center, v: ss.quantile(readings, 0.25) });
      series.p50.push({ t: center, v: ss.quantile(readings, 0.5) });
      series.p75.push({ t: center, v: ss.quantile(readings, 0.75) });
      series.p90.push({ t: center, v: ss.quantile(readings, 0.9) });
      bins.push(center);
    }
  }

  var high = options.targetHigh; // display units
  var low = options.targetLow;   // display units

  $('#percentile-chart').empty();

  if (series.p50.length === 0) {
    return;
  }

  var container = document.getElementById('percentile-chart');
  var totalWidth = (container && container.clientWidth) ? container.clientWidth : 1000;
  if (totalWidth < 400) {
    totalWidth = (typeof $ !== 'undefined' && $('#percentile-chart').width()) || 1000;
    if (totalWidth < 400) { totalWidth = 1000; }
  }
  var totalHeight = 440;
  var margin = { top: 14, right: 24, bottom: 30, left: 48 };
  var width = totalWidth - margin.left - margin.right;
  var height = totalHeight - margin.top - margin.bottom;

  // y range: 0 -> max of p90 and targetHigh, padded.
  var p90max = d3.max(series.p90, function(d) { return d.v; }) || 0;
  var yMax = Math.max(p90max, high) * 1.1;
  if (!isFinite(yMax) || yMax <= 0) { yMax = isMmol ? 22 : 400; }
  var yMin = 0;

  var x = d3.scaleLinear().domain([0, 1440]).range([0, width]);
  var y = d3.scaleLinear().domain([yMin, yMax]).range([height, 0]);

  var svg = d3.select('#percentile-chart').append('svg')
    .attr('width', totalWidth)
    .attr('height', totalHeight);
  var g = svg.append('g').attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

  // ---- gridlines ----
  var xTicks = [0, 180, 360, 540, 720, 900, 1080, 1260, 1440];
  g.append('g')
    .attr('class', 'percentile-grid')
    .selectAll('line.vgrid')
    .data(xTicks)
    .enter()
    .append('line')
    .attr('x1', function(d) { return x(d); })
    .attr('x2', function(d) { return x(d); })
    .attr('y1', 0)
    .attr('y2', height)
    .attr('stroke', '#eceff1')
    .attr('stroke-width', 1);

  g.append('g')
    .attr('class', 'percentile-grid')
    .selectAll('line.hgrid')
    .data(y.ticks(6))
    .enter()
    .append('line')
    .attr('x1', 0)
    .attr('x2', width)
    .attr('y1', function(d) { return y(d); })
    .attr('y2', function(d) { return y(d); })
    .attr('stroke', '#eceff1')
    .attr('stroke-width', 1);

  // ---- target range green band ----
  g.append('rect')
    .attr('class', 'percentile-fill')
    .attr('x', 0)
    .attr('y', y(high))
    .attr('width', width)
    .attr('height', Math.max(0, y(low) - y(high)))
    .attr('fill', 'rgba(76,175,80,0.12)')
    .style('print-color-adjust', 'exact');

  // ---- percentile bands (back to front) ----
  var areaGen = function(lo, hi) {
    return d3.area()
      .curve(d3.curveCatmullRom)
      .x(function(d, i) { return x(lo[i].t); })
      .y0(function(d, i) { return y(lo[i].v); })
      .y1(function(d, i) { return y(hi[i].v); });
  };

  // outer band p10-p90
  g.append('path')
    .attr('class', 'percentile-fill')
    .datum(series.p90)
    .attr('fill', 'rgba(86,170,236,0.20)')
    .attr('d', areaGen(series.p10, series.p90))
    .style('print-color-adjust', 'exact');

  // inner band p25-p75
  g.append('path')
    .attr('class', 'percentile-fill')
    .datum(series.p75)
    .attr('fill', 'rgba(86,170,236,0.40)')
    .attr('d', areaGen(series.p25, series.p75))
    .style('print-color-adjust', 'exact');

  // median line p50
  var lineGen = d3.line()
    .curve(d3.curveCatmullRom)
    .x(function(d) { return x(d.t); })
    .y(function(d) { return y(d.v); });
  g.append('path')
    .datum(series.p50)
    .attr('fill', 'none')
    .attr('stroke', '#1f6fc4')
    .attr('stroke-width', 2.5)
    .attr('d', lineGen);

  // ---- target reference dashed lines ----
  g.append('line')
    .attr('x1', 0).attr('x2', width)
    .attr('y1', y(low)).attr('y2', y(low))
    .attr('stroke', '#ff5959').attr('stroke-width', 1).attr('stroke-dasharray', '4,3');
  g.append('line')
    .attr('x1', 0).attr('x2', width)
    .attr('y1', y(high)).attr('y2', y(high))
    .attr('stroke', '#ffa000').attr('stroke-width', 1).attr('stroke-dasharray', '4,3');

  // ---- axes ----
  var xAxis = d3.axisBottom(x)
    .tickValues(xTicks)
    .tickFormat(function(m) {
      var hh = Math.floor(m / 60);
      return (hh < 10 ? '0' + hh : '' + hh) + ':00';
    });
  var gx = g.append('g')
    .attr('transform', 'translate(0,' + height + ')')
    .call(xAxis);
  gx.selectAll('text').style('font-size', '11px').style('fill', '#607d8b');
  gx.selectAll('.tick line').attr('stroke', '#cfd8dc');
  gx.select('.domain').attr('stroke', '#cfd8dc');

  var yAxis = d3.axisLeft(y).ticks(6).tickFormat(function(v) { return fmtVal(v); });
  var gy = g.append('g').call(yAxis);
  gy.selectAll('text').style('font-size', '11px').style('fill', '#607d8b');
  gy.selectAll('.tick line').attr('stroke', '#cfd8dc');
  gy.select('.domain').attr('stroke', '#cfd8dc');

  g.append('text')
    .attr('transform', 'rotate(-90)')
    .attr('x', -height / 2)
    .attr('y', -36)
    .attr('text-anchor', 'middle')
    .style('font-size', '11px').style('fill', '#607d8b')
    .text(isMmol ? 'mmol/L' : 'mg/dL');

  // ---- hover tooltip ----
  var tooltip = d3.select('#percentile-chart').append('div')
    .attr('id', 'percentile-tooltip');

  function nearestIndex(minuteOfDay) {
    // series arrays share identical t values; find closest bin center.
    var best = 0;
    var bestDist = Infinity;
    for (var i = 0; i < series.p50.length; i++) {
      var dist = Math.abs(series.p50[i].t - minuteOfDay);
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return best;
  }

  var hoverLine = g.append('line')
    .attr('y1', 0).attr('y2', height)
    .attr('stroke', '#90a4ae').attr('stroke-width', 1).attr('stroke-dasharray', '3,3')
    .style('opacity', 0);

  g.append('rect')
    .attr('width', width)
    .attr('height', height)
    .attr('fill', 'none')
    .style('pointer-events', 'all')
    .on('mouseout', function() {
      tooltip.style('opacity', 0);
      hoverLine.style('opacity', 0);
    })
    .on('mousemove', function(event) {
      var mx = d3.pointer(event, this)[0];
      var minuteOfDay = x.invert(mx);
      var i = nearestIndex(minuteOfDay);
      var p = {
        t: series.p50[i].t
        , p10: series.p10[i].v
        , p25: series.p25[i].v
        , p50: series.p50[i].v
        , p75: series.p75[i].v
        , p90: series.p90[i].v
      };
      var hh = Math.floor(p.t / 60);
      var mm = Math.round(p.t % 60);
      var hourLabel = (hh < 10 ? '0' + hh : '' + hh) + ':' + (mm < 10 ? '0' + mm : '' + mm);

      hoverLine
        .attr('x1', x(p.t)).attr('x2', x(p.t))
        .style('opacity', 1);

      var html = '<div class="percentile-tt-h">' + hourLabel + '</div>'
        + '90%: ' + fmtVal(p.p90) + '<br/>'
        + '75%: ' + fmtVal(p.p75) + '<br/>'
        + translate('Median') + ': ' + fmtVal(p.p50) + '<br/>'
        + '25%: ' + fmtVal(p.p25) + '<br/>'
        + '10%: ' + fmtVal(p.p10);
      tooltip.html(html);

      var ttLeft = margin.left + x(p.t) + 12;
      var ttNode = tooltip.node();
      var ttWidth = ttNode ? ttNode.offsetWidth : 80;
      if (ttLeft + ttWidth > totalWidth) {
        ttLeft = margin.left + x(p.t) - ttWidth - 12;
      }
      tooltip
        .style('left', ttLeft + 'px')
        .style('top', (margin.top + 8) + 'px')
        .style('opacity', 1);
    });
};
