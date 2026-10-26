'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {entries, output, measure} = require('../tools/measure-page-bundles');

// Measured prototype d79b8a74 with Node 22.23.2/24.20.0 zlib level 9:
// 332151/53156/7923/6665/5306/61784 bytes; 405201 across application entries.
// Re-measured on b8ff91cb, after merging dev eb72a1d3 (opt-in modern theme, #8831), with Node
// 24.22.1: 341123/50948/7923/7017/5285/61736 bytes; 412296 across application
// entries, against 506304 for dev's single bundle.app.js. App and total keep their
// earlier allowances (7849 and about 4800 bytes) over that measurement.
// These bounded allowances permit small fixes, not restoring the
// monolithic dashboard. Update only with a reviewed resource measurement.
// AGP/D3 report features measured on patched Node 24.22.1 after removing unused
// Flot pie/fillbetween plugins: 58638 reports / 423281 total gzip bytes.
// Final Modern daily rendering, combined hover and compact treatment rows:
// 61032 reports / 425675 total gzip bytes on patched Node 24.22.1. Static chart
// styles are loaded as CSS. See the modernReportRefinements audit entry.
// Only reports and total allowances increase; other page limits stay fixed.
const limits = {app: 349000, reports: 61500, admin: 8500, profile: 7100, food: 5700, clock: 63000};

describe('Production page bundle resource budgets', function () {
  let measurements;
  before(function () {measurements = measure();});
  for (const entry of entries) {
    it('keeps ' + entry + ' within its measured gzip budget', function () {
      const actual = measurements.bundles[entry].gzipBytes;
      assert.ok(actual <= limits[entry], entry + ': ' + actual + ' gzip bytes exceeds ' + limits[entry]);
    });
  }
  it('does not emit additional JavaScript chunks outside these budgets', function () {
    const emitted = fs.readdirSync(output).filter(name => name.endsWith('.js')).sort();
    assert.deepEqual(emitted, entries.map(entry => 'bundle.' + entry + '.js').sort());
  });
  it('keeps the total for visiting every application page within 426000 gzip bytes', function () {
    assert.ok(measurements.allApplicationGzipBytes <= 426000,
      'All application entries: ' + measurements.allApplicationGzipBytes + ' gzip bytes exceeds 426000');
  });
  it('emits report modules only in the reports entry', function () {
    for (const entry of entries) {
      const map = JSON.parse(fs.readFileSync(path.join(output, 'bundle.' + entry + '.js.map'), 'utf8'));
      const reportSources = map.sources.filter(source => /\/node_modules\/flot\/|\/lib\/report(?:_plugins)?\//.test(source));
      if (entry === 'reports') {
        assert.ok(reportSources.some(source => source.endsWith('/flot/jquery.flot.js')), 'Reports must include the real Flot implementation');
        assert.ok(reportSources.some(source => source.endsWith('/report_plugins/index.js')), 'Reports must include report plugins');
      } else assert.deepEqual(reportSources, [], entry + ' must not contain report code');
    }
  });
});
