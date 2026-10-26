'use strict';

var trace = require('./glucose-trace');

module.exports = function drawModernChart (client, d3, context) {
  var chart = client.chart;
  var root = context ? chart.context : chart.focus;
  var x = context ? chart.xScale2 : chart.xScale;
  var y = context ? chart.yScale2 : chart.yScale;
  var height = context ? chart.contextHeight : chart.focusHeight;
  var layer = root.selectAll('g.modern-lines').data([null]).join('g')
    .attr('class', 'modern-lines');
  layer.lower();

  var clipId = context ? 'modern-context-clip' : 'modern-focus-clip';
  layer.selectAll('clipPath').data([null]).join('clipPath').attr('id', clipId)
    .selectAll('rect').data([null]).join('rect')
    .attr('width', Math.max(0, chart.prevChartWidth)).attr('height', Math.max(0, height));
  var plot = layer.selectAll('g.modern-plot').data([null]).join('g')
    .attr('class', 'modern-plot').attr('clip-path', 'url(#' + clipId + ')');

  if (!context) {
    var thresholds = client.settings.thresholds;
    var top = y(client.utils.scaleMgdl(thresholds.bgTargetTop));
    var bottom = y(client.utils.scaleMgdl(thresholds.bgTargetBottom));
    plot.selectAll('rect.modern-target-band').data([null]).join('rect')
      .attr('class', 'modern-target-band').attr('x', 0).attr('y', top)
      .attr('width', chart.prevChartWidth).attr('height', Math.max(0, bottom - top));
  }

  // The connecting stroke is a labelled, smoothed trend. Original samples
  // stay at their exact coordinates for hit-testing and hover markers.
  var line = d3.line().x(function (p) { return x(new Date(p.mills)); })
    .y(function (p) { return y(client.sbx.scaleEntry(p)); })
    .curve(d3.curveBasis);
  var readings = client.entries.filter(function (p) { return p.type === 'sgv'; });
  var runs = trace.segments(readings);
  var connected = new Set();
  runs.forEach(function (run) { run.points.forEach(function (p) { connected.add(p); }); });
  root.selectAll(context ? 'circle' : 'circle.entry-dot').classed('modern-connected-sample', function (p) {
    return p && p.type === 'sgv' && connected.has(p) && p.color !== 'red' &&
      !(client.latestSGV && p.mills === client.latestSGV.mills);
  });
  plot.selectAll('path.modern-trace').data(runs).join('path')
    .attr('class', 'modern-trace').attr('stroke', function (run) { return run.color; })
    .attr('d', function (run) { return line(run.points); });

  if (!context) {
    var forecastLine = d3.line().x(function (p) { return x(new Date(p.mills)); })
      .y(function (p) { return y(client.sbx.scaleEntry(p)); }).curve(d3.curveMonotoneX);
    plot.selectAll('path.modern-forecast-line').data(trace.forecasts(chart.getForecastData())).join('path')
      .attr('class', 'modern-forecast-line').attr('stroke', function (run) { return run.color; })
      .attr('d', function (run) { return forecastLine(run.points); });

    root.selectAll('text.modern-trace-label').data(runs.length ? [null] : []).join('text')
      .attr('class', 'modern-trace-label').attr('x', 8).attr('y', 15)
      .text(client.translate('Smoothed trend'));

    var nowX = x(new Date(client.now));
    var label = nowX >= 40 && nowX <= chart.prevChartWidth - 20 ? [nowX] : [];
    root.selectAll('text.modern-now-label').data(label).join('text')
      .attr('class', 'modern-now-label').attr('x', function (value) { return value - 8; }).attr('y', 15)
      .text(client.translate('Now'));
  }
};
