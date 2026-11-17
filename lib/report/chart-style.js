'use strict';

const htmlUtils = require('../utils/html');
const storage = require('../client/storage').localStorage;

function savedStyle (report) {
  try { return storage.get('reportChartStyle_' + report) === 'pie' ? 'pie' : 'bar'; }
  catch { return 'bar'; }
}

function html (report, translate) {
  const name = report + '-chartstyle';
  const selected = savedStyle(report);
  return '<fieldset class="report-chart-style"><legend>' + htmlUtils.textAsHtml(translate('Chart style')) + '</legend>' +
    ['bar', 'pie'].map(style => '<label for="' + name + '-' + style + '"><input type="radio" name="' + name +
      '" id="' + name + '-' + style + '" value="' + style + '"' + (selected === style ? ' checked' : '') + '> ' +
      htmlUtils.textAsHtml(translate(style === 'pie' ? 'Pie' : 'Bar')) + '</label>').join('') + '</fieldset>';
}

function bind (report, onChange) {
  const controls = window.$('input[name="' + report + '-chartstyle"]');
  controls.off('change.chartStyle').on('change.chartStyle', function () {
    const style = this.value === 'pie' ? 'pie' : 'bar';
    // Browser storage can be unavailable or full; the current view still switches.
    try { storage.set('reportChartStyle_' + report, style); } catch { /* use the current selection */ }
    onChange(style);
  });
  return controls.filter(':checked').val() === 'pie' ? 'pie' : 'bar';
}

function pie (host, bands, size, label, showLabels) {
  const d3 = require('../d3.mjs');
  const description = bands.map(band => band.label + ': ' + band.percent + '%').join(', ');
  const chart = d3.select(host).append('svg').attr('class', 'report-distribution-pie')
    .attr('viewBox', '0 0 ' + size + ' ' + size).attr('width', size).attr('height', size)
    .attr('role', 'img').attr('aria-label', label + '. ' + description);
  const slices = d3.pie().value(band => band.value).sort(null)(bands.filter(band => band.value > 0));
  const arc = d3.arc().innerRadius(0).outerRadius(size / 2 - 2);
  const group = chart.append('g').attr('transform', 'translate(' + size / 2 + ',' + size / 2 + ')');
  group.selectAll('path').data(slices).enter().append('path').attr('d', arc)
    .attr('fill', slice => slice.data.color).attr('stroke', '#fff').attr('stroke-width', 1)
    .append('title').text(slice => slice.data.label + ': ' + slice.data.percent + '%');
  if (showLabels) {
    const labels = d3.arc().innerRadius(size * .30).outerRadius(size * .30);
    group.selectAll('text').data(slices.filter(slice => Number(slice.data.percent) >= 5)).enter().append('text')
      .attr('transform', slice => 'translate(' + labels.centroid(slice) + ')')
      .attr('text-anchor', 'middle').attr('dy', '.35em').text(slice => slice.data.percent + '%');
  }
  return chart;
}

module.exports = {html, bind, pie};
