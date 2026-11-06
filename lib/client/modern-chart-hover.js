'use strict';

var trace = require('./glucose-trace');

// Listen on the plot group, with an empty-area hit surface behind its controls.
// Treatment targets and the separate history brush retain their own events.
module.exports = function bindModernChartHover (client, d3, showColumn, hide, pause) {
  var chart = client.chart;
  var root = chart.focus;
  client.tooltip.classed('modern-chart-tooltip', true);
  var columns = new Map();
  var forecasts = new Map();
  root.selectAll('circle.entry-dot, circle.forecast-dot').each(function (p) {
    var x = +this.getAttribute('cx');
    if (!['sgv', 'mbg', 'forecast'].includes(p.type) || !trace.valid(p, p.type === 'forecast' ? 13 : 39) ||
      x < 0 || x > chart.prevChartWidth) return;
    var time = p.type === 'forecast' && Number.isFinite(p.forecastMills) ? p.forecastMills : p.mills;
    if (!columns.has(time)) columns.set(time, {mills: time, nodes: []});
    columns.get(time).nodes.push(this);
    if (p.type === 'forecast') {
      var key = JSON.stringify([p.info && p.info.type, p.forecastType, p.forecastSeries]);
      if (!forecasts.has(key)) forecasts.set(key, []);
      forecasts.get(key).push({mills: time, node: this});
    }
  });
  var ordered = Array.from(columns.values()).sort(function (a, b) { return a.mills - b.mills; });
  var nearest = d3.bisector(function (column) { return column.mills; }).center;
  forecasts.forEach(function (series) {
    series.sort(function (a, b) { return a.mills - b.mills; });
    var steps = series.slice(1).map(function (point, index) { return point.mills - series[index].mills; })
      .filter(function (step) { return step > 0 && step <= 300000; }).sort(function (a, b) { return a - b; });
    series.tolerance = (steps.length ? steps[Math.floor((steps.length - 1) / 2)] : 300000) / 2;
  });

  function inspect (event, time) {
    if (!ordered.length) { hide(); return; }
    var column = ordered[nearest(ordered, time)];
    var nodes = column.nodes.filter(function (node) { return d3.select(node).datum().type !== 'forecast'; });
    forecasts.forEach(function (series) {
      var point = series[nearest(series, column.mills)];
      if (Math.abs(point.mills - column.mills) <= series.tolerance) nodes.push(point.node);
    });
    showColumn(event, nodes, column.mills);
  }

  root.selectAll('rect.modern-hover-area').data([null]).join('rect')
    .attr('class', 'modern-hover-area').attr('width', chart.prevChartWidth).attr('height', chart.focusHeight)
    .attr('fill', 'transparent').attr('pointer-events', 'all').lower();

  root.on('mousemove.modern-column', function (event) {
    if (event.buttons || client.editMode || (event.target.closest &&
      event.target.closest('.treatment-dot, .draggable-treatment, .g-duration, .g-profile, .drag-area'))) {
      root.selectAll('.modern-hover-dot, .modern-hover-guide').remove();
      if (pause) pause();
      return;
    }
    var position = d3.pointer(event, root.node());
    if (!ordered.length || position[0] < 0 || position[0] > chart.prevChartWidth ||
      position[1] < 0 || position[1] > chart.focusHeight) {
      hide();
      return;
    }
    var time = +chart.xScale.invert(position[0]);
    inspect(event, time);
  }).on('mouseleave.modern-column', hide);
  return inspect;
};
