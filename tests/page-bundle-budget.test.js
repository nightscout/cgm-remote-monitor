'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {entries, output, measure} = require('../tools/measure-page-bundles');

// Measured prototype d79b8a74 with Node 22.23.2/24.20.0 zlib level 9:
// 332151/53156/7923/6665/5306/61784 bytes; 405201 across application entries.
// These bounded allowances permit small fixes, not restoring the 402808-byte
// monolithic dashboard. Update only with a reviewed resource measurement.
const limits = {app: 340000, reports: 55000, admin: 8500, profile: 7100, food: 5700, clock: 63000};

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
  it('keeps the total for visiting every application page within 410000 gzip bytes', function () {
    assert.ok(measurements.allApplicationGzipBytes <= 410000,
      'All application entries: ' + measurements.allApplicationGzipBytes + ' gzip bytes exceeds 410000');
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
