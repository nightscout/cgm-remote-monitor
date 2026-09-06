'use strict';

// Real chart and renderer with only application services replaced by deterministic data.
module.exports = function (d3, window, units) {
  const now = Date.parse('2025-01-01T12:00:00Z');
  const hour = 3600000;
  const client = {
    now: now, forecastTime: now, defaultForecastTime: 0, focusRangeMS: 3 * hour,
    entries: [], settings: {language: 'en', scaleY: 'linear', timeFormat: 24,
      units: units || 'mg/dl', showForecast: '',
      thresholds: {bgLow: 55, bgTargetBottom: 80, bgTargetTop: 180, bgHigh: 260}},
    dataExtent: () => [new Date(now - 12 * hour), new Date(now)],
    ticks: () => [80, 180], translate: value => value, formatTime: () => '12:00',
    utils: {scaleMgdl: value => units === 'mmol' ? value / 18 : value,
      toRoundedStr: value => String(value)},
    sbx: {scaleEntry: entry => units === 'mmol' ? entry.mgdl / 18 : entry.mgdl,
      pluginBase: {forecastPoints: {}}, withExtendedSettings: () => ({})},
    rawbg: {noiseCodeToDisplay: () => '', showRawBGs: () => false},
    ddata: {cal: [], profile: {getUnits: () => units || 'mg/dl'}},
    careportal: {resolveEventName: value => value},
    browserUtils: {closeLastOpenedDrawer: () => {}},
    loadRetroIfNeeded: () => {},
    brushed: () => {
      if (client.chart) client.chart.xScale.domain(client.chart.createAdjustedRange());
    }
  };
  window.document.body.innerHTML = '<div style="width:900px"><div><div id="tooltip"></div></div></div><div id="chartContainer"></div>';
  window.document.querySelector('#chartContainer').getBoundingClientRect = () => ({width: 900, height: 600});
  client.tooltip = d3.select('#tooltip');
  client.renderer = require('../../lib/client/renderer')(client, d3);
  client.chart = require('../../lib/client/chart')(client, d3, window.$);
  // jsdom has no SVG animated width/height; provide the same explicit chart extent.
  client.chart.brush.extent([[0, 0], [900, 171]]);
  client.chart.update(true);
  return client;
};
