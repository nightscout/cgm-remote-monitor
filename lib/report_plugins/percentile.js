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

percentile.report = function report_percentile(datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var moment = window.moment;
  var profile = client.sbx.data.profile;
  var ss = require('../report/statistics');
  var d3 = (global && global.d3) || require('../d3.mjs');
  var plainAxis = require('../report/plain-axis');

  var minutewindow = 30; //minute-window should be a divisor of 60

  var data = datastorage.allstatsrecords;

  var filterFunc = function withinWindow(record) {
    var recdate = profile.applyTimezone(moment(record.displayTime));
    return recdate.hour() === hour && recdate.minute() >= minute && recdate.minute() < minute + minutewindow;
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
  // Retain empty bins as gaps in every line and percentile band.
  var series = { p10: [], p25: [], p50: [], p75: [], p90: [] };
  for (var hour = 0; hour < 24; hour++) {
    for (var minute = 0; minute < 60; minute = minute + minutewindow) {
      var readings = data.filter(filterFunc).map(function(record) {
        return record.sgv;
      });
      var quantiles = ss.quantile(readings, [0.1, 0.25, 0.5, 0.75, 0.9]);
      var center = hour * 60 + minute + minutewindow / 2;
      series.p10.push({ t: center, v: quantiles ? quantiles[0] : null });
      series.p25.push({ t: center, v: quantiles ? quantiles[1] : null });
      series.p50.push({ t: center, v: quantiles ? quantiles[2] : null });
      series.p75.push({ t: center, v: quantiles ? quantiles[3] : null });
      series.p90.push({ t: center, v: quantiles ? quantiles[4] : null });
    }
  }

  var high = options.targetHigh; // display units
  var low = options.targetLow;   // display units

  $('#percentile-chart').empty();

  if (!series.p50.some(function(point) { return point.v !== null; })) {
    return;
  }

  var container = document.getElementById('percentile-chart');
  var totalWidth = (container && container.clientWidth) ? container.clientWidth : 1000;
  totalWidth = Math.max(240, totalWidth);
  var totalHeight = 440;
  var margin = { top: 14, right: 24, bottom: 30, left: 48 };
  var width = totalWidth - margin.left - margin.right;
  var height = totalHeight - margin.top - margin.bottom;

  // y range: 0 -> max of p90 and targetHigh, padded.
  var p90max = d3.max(series.p90, function(d) { return d.v; }) || 0;
  var yMax = Math.max(p90max, high) * 1.1;
  if (!isFinite(yMax) || yMax <= 0) { yMax = isMmol ? 22 : 400; }
  var yMin = 0;

  var x = d3.scaleLinear().domain([0, 1440]).rangeRound([0, width]);
  var y = d3.scaleLinear().domain([yMin, yMax]).rangeRound([height, 0]);

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
    .attr('y2', height);

  g.append('g')
    .attr('class', 'percentile-grid')
    .selectAll('line.hgrid')
    .data(y.ticks(6))
    .enter()
    .append('line')
    .attr('x1', 0)
    .attr('x2', width)
    .attr('y1', function(d) { return y(d); })
    .attr('y2', function(d) { return y(d); });

  // ---- target range green band ----
  g.append('rect')
    .attr('class', 'percentile-target-band')
    .attr('x', 0)
    .attr('y', y(high))
    .attr('width', width)
    .attr('height', Math.max(0, y(low) - y(high)));

  // ---- percentile bands (back to front) ----
  var areaGen = function(lo, hi) {
    return d3.area().digits(0)
      .defined(function(d, i) { return lo[i].v !== null && hi[i].v !== null; })
      .curve(d3.curveMonotoneX)
      .x(function(d, i) { return x(lo[i].t); })
      .y0(function(d, i) { return y(lo[i].v); })
      .y1(function(d, i) { return y(hi[i].v); });
  };

  // outer band p10-p90
  g.append('path')
    .attr('class', 'percentile-band-outer')
    .datum(series.p90)
    .attr('d', areaGen(series.p10, series.p90));

  // inner band p25-p75
  g.append('path')
    .attr('class', 'percentile-band-inner')
    .datum(series.p75)
    .attr('d', areaGen(series.p25, series.p75));

  // median line p50
  var lineGen = d3.line().digits(0)
    .defined(function(d) { return d.v !== null; })
    .curve(d3.curveMonotoneX)
    .x(function(d) { return x(d.t); })
    .y(function(d) { return y(d.v); });
  g.append('path')
    .attr('class', 'percentile-median')
    .datum(series.p50)
    .attr('d', lineGen);

  // ---- target reference dashed lines ----
  g.append('line')
    .attr('class', 'percentile-target-line percentile-target-low')
    .attr('x1', 0).attr('x2', width)
    .attr('y1', y(low)).attr('y2', y(low));
  g.append('line')
    .attr('class', 'percentile-target-line percentile-target-high')
    .attr('x1', 0).attr('x2', width)
    .attr('y1', y(high)).attr('y2', y(high));

  // ---- axes ----
  var xAxis = d3.axisBottom(x).offset(0)
    .tickValues(xTicks)
    .tickFormat(function(m) {
      var hh = Math.floor(m / 60);
      return (hh < 10 ? '0' + hh : '' + hh) + ':00';
    });
  g.append('g')
    .attr('class', 'percentile-axis')
    .attr('transform', 'translate(0,' + height + ')')
    .call(xAxis).call(plainAxis, 'bottom');

  var yAxis = d3.axisLeft(y).offset(0).ticks(6).tickFormat(function(v) { return fmtVal(v); });
  g.append('g').attr('class', 'percentile-axis').call(yAxis).call(plainAxis, 'left');

  g.append('text')
    .attr('transform', 'rotate(-90)')
    .attr('x', -Math.round(height / 2))
    .attr('y', -36)
    .attr('class', 'percentile-axis-label')
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
    .attr('class', 'percentile-hover-line')
    .attr('y1', 0).attr('y2', height);

  g.append('rect')
    .attr('class', 'percentile-hover-target')
    .attr('width', width)
    .attr('height', height)
    .on('mouseout', function() {
      tooltip.classed('is-visible', false);
      hoverLine.classed('is-visible', false);
    })
    .on('mousemove', function(event) {
      var mx = d3.pointer(event, this)[0];
      var minuteOfDay = x.invert(mx);
      var i = nearestIndex(minuteOfDay);
      if (series.p50[i].v === null) {
        tooltip.classed('is-visible', false);
        hoverLine.classed('is-visible', false);
        return;
      }
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
        .classed('is-visible', true);

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
        .classed('is-visible', true);
    });
};
