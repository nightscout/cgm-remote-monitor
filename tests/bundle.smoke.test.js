'use strict';

// Phase 5c — bundle smoke test.
//
// The skipped tests/reports.test.js asserted that a freshly-built
// bundle would boot Nightscout's report client end-to-end through
// jsdom and render plugin HTML. Per-plugin stats math is already
// exercised by dedicated suites (basalprofileplugin.test.js,
// daytodayplugin.test.js, foodstatsplugin.test.js, etc.), so the
// remaining gap is purely structural: "did webpack produce a bundle
// that exposes Nightscout.client / .reportclient / .profileclient
// without throwing on first execute?".
//
// This suite skips cleanly when the build artifact is missing so it
// does not break a fresh checkout that has not yet run `npm install`
// (which triggers `npm run bundle` via postinstall) or `npm run
// bundle` directly.

require('should');
var fs = require('fs');
var path = require('path');

var BUNDLE_PATH = path.resolve(
  __dirname, '..', 'node_modules', '.cache', '_ns_cache', 'public', 'js', 'bundle.app.js'
);

describe('Bundle smoke', function () {
  this.timeout(30000);

  if (!fs.existsSync(BUNDLE_PATH)) {
    it.skip('bundle.app.js not built — skipping (run `npm run bundle` to enable)', function () {});
    return;
  }

  var jsdom;
  try {
    jsdom = require('jsdom');
  } catch (e) {
    it.skip('jsdom not installed — skipping', function () {});
    return;
  }

  var dom;

  before(function (done) {
    var bundleSrc = fs.readFileSync(BUNDLE_PATH, 'utf8');
    dom = new jsdom.JSDOM(
      '<!DOCTYPE html><html><head></head><body></body></html>',
      {
        url: 'http://localhost/',
        pretendToBeVisual: true,
        runScripts: 'outside-only'
      }
    );
    // Suppress noisy console output from the bundle during smoke boot.
    dom.window.console = { log: function(){}, info: function(){}, warn: function(){}, error: function(){} };
    try {
      dom.window.eval(bundleSrc);
      done();
    } catch (err) {
      done(err);
    }
  });

  after(function () {
    if (dom) dom.window.close();
  });

  it('exposes window.Nightscout namespace', function () {
    var ns = dom.window.Nightscout;
    (ns === null || ns === undefined).should.be.false();
    (typeof ns).should.equal('object');
  });

  it('exposes Nightscout.client with an init function', function () {
    var client = dom.window.Nightscout.client;
    (typeof client).should.equal('object');
    (typeof client.init).should.equal('function');
  });

  it('exposes Nightscout.reportclient (function)', function () {
    (typeof dom.window.Nightscout.reportclient).should.equal('function');
  });

  it('exposes Nightscout.profileclient (function)', function () {
    (typeof dom.window.Nightscout.profileclient).should.equal('function');
  });

  it('exposes Nightscout.units with mgdlToMMOL and mmolToMgdl', function () {
    var units = dom.window.Nightscout.units;
    (typeof units).should.equal('object');
    (typeof units.mgdlToMMOL).should.equal('function');
    (typeof units.mmolToMgdl).should.equal('function');
  });
});
