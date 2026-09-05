'use strict';

/*
 * Plugin-wiring test for lib/plugins/loop.js.
 *
 * Verifies that the plugin's analyzeData() forwards
 * (filtered devicestatus, recent moment, { moment }) to the pure
 * lib/client-core/devicestatus/loop module rather than reimplementing
 * the reduction inline. Mirrors openaps-plugin-wiring.test.js — the
 * sandbox-shape filter (`'loop' in status` plus the recentMills
 * window) and the `recent = sbx.time - warn/2` math live in the
 * plugin; everything else lives in the pure module.
 *
 * Implementation note: the stub is installed via require.cache before
 * the plugin is required, so the plugin's `var selectLoopState =
 * require('../client-core/devicestatus/loop')` picks it up. We clear
 * the plugin's cache slot on `after()` so subsequent suites pick up
 * the real module.
 */

require('should');

var SELECT_PATH = require.resolve('../../lib/client-core/devicestatus/loop');
var calls = [];
var SENTINEL = {
  lastLoop: null
  , lastEnacted: null
  , lastPredicted: null
  , lastOverride: null
  , lastOkMoment: null
  , display: { symbol: '?', code: 'waiting', label: 'Waiting' }
};
var stub = function (records, recent, opts) {
  calls.push({ records: records, recent: recent, opts: opts });
  return SENTINEL;
};
stub.selectLoopState = stub;
stub.buildDisplay = function () { return SENTINEL.display; };

require.cache[SELECT_PATH] = { id: SELECT_PATH, filename: SELECT_PATH, loaded: true, exports: stub };

var PLUGIN_PATH = require.resolve('../../lib/plugins/loop');
delete require.cache[PLUGIN_PATH];

var moment = require('moment');
var levels = require('../../lib/levels');
var language = require('../../lib/language')(require('fs'));
language.set('en');
var ctx = { language: language, settings: { units: 'mg/dl' }, levels: levels, moment: moment };
var loop = require(PLUGIN_PATH)(ctx);

describe('plugin wiring: loop.analyzeData → selectLoopState', function () {
  after(function () {
    delete require.cache[SELECT_PATH];
    delete require.cache[PLUGIN_PATH];
  });

  it('forwards (recentData, recent, { moment }) and filters out non-loop / out-of-window records', function () {
    calls.length = 0;
    var now = Date.parse('2026-05-09T00:00:00Z');
    var inWindow = now - 60000;       // 1 minute ago — within the 6h recent window
    var tooOld = now - 8 * 3600000;  // 8h ago — outside the window
    var sbx = {
      time: now
      , data: { devicestatus: [
        { mills: inWindow, loop: { timestamp: 'x' } }       // KEEP
        , { mills: inWindow }                                // SKIP (no loop)
        , { mills: tooOld, loop: { timestamp: 'y' } }       // SKIP (out of window)
      ] }
      , entryMills: function (s) { return s.mills; }
      , extendedSettings: {}
    };
    var out = loop.analyzeData(sbx);
    out.should.equal(SENTINEL);
    calls.length.should.equal(1);
    calls[0].records.length.should.equal(1);
    calls[0].records[0].loop.timestamp.should.equal('x');
    moment.isMoment(calls[0].recent).should.be.true();
    (typeof calls[0].opts.moment).should.equal('function');
  });
});
