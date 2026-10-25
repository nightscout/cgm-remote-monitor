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

  // Shape-preserving interpolation passes through the exact observations.
  // Keep gaps and colour/forecast boundaries in the existing segmentation.
  var line = d3.line().x(function (p) { return x(new Date(p.mills)); })
    .y(function (p) { return y(client.sbx.scaleEntry(p)); })
    .curve(d3.curveMonotoneX);
  var readings = client.entries.filter(function (p) { return p.type === 'sgv'; });
  plot.selectAll('path.modern-trace').data(trace.segments(readings)).join('path')
    .attr('class', 'modern-trace').attr('stroke', function (run) { return run.color; })
    .attr('d', function (run) { return line(run.points); });

  if (!context) {
    plot.selectAll('path.modern-forecast-line').data(trace.forecasts(chart.getForecastData())).join('path')
      .attr('class', 'modern-forecast-line').attr('stroke', function (run) { return run.color; })
      .attr('d', function (run) { return line(run.points); });

    var nowX = x(new Date(client.now));
    var label = nowX >= 40 && nowX <= chart.prevChartWidth - 20 ? [nowX] : [];
    root.selectAll('text.modern-now-label').data(label).join('text')
      .attr('class', 'modern-now-label').attr('x', function (value) { return value - 8; }).attr('y', 15)
      .text(client.translate('Now'));
  }
};
