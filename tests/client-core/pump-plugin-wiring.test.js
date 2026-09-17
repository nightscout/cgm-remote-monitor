'use strict';

/*
 * Plugin-wiring test for lib/plugins/pump.js.
 *
 * Verifies that the pump plugin's setProperties closure delegates
 * latest-pump-status selection to the pure
 * lib/client-core/devicestatus/pump module. The sandbox-flavoured
 * filter (`'pump' in status` plus the urgentClock*2 window) lives
 * in the plugin; the latest-by-pump.clock-fallback-to-mills selection
 * lives in the pure module.
 *
 * Note: this file is alphabetically AFTER pill-goldens.test.js, so we
 * MUST install the require.cache stub inside before() (not at module
 * top-level) — otherwise the stub leaks into the captured-fixture
 * pill golden run and corrupts pump-pill output across all sources.
 */

require('should');

var SELECT_PATH = require.resolve('../../lib/client-core/devicestatus/pump');
var PLUGIN_PATH = require.resolve('../../lib/plugins/pump');

describe('plugin wiring: pump.setProperties → selectLatestPumpStatus', function () {
  var calls;
  var pump;

  before(function () {
    calls = [];
    var SENTINEL = { mills: 99999, pump: { clock: '2026-05-09T00:00:00Z' }, clockMills: 1 };
    var stub = function (records, opts) {
      calls.push({ records: records, opts: opts });
      return SENTINEL;
    };
    stub.selectLatestPumpStatus = stub;
    require.cache[SELECT_PATH] = { id: SELECT_PATH, filename: SELECT_PATH, loaded: true, exports: stub };
    delete require.cache[PLUGIN_PATH];
    var moment = require('moment');
    var levels = require('../../lib/levels');
    var language = require('../../lib/language')(require('fs'));
    language.set('en');
    var ctx = { language: language, settings: { units: 'mg/dl' }, levels: levels, moment: moment };
    pump = require(PLUGIN_PATH)(ctx);
  });

  after(function () {
    delete require.cache[SELECT_PATH];
    delete require.cache[PLUGIN_PATH];
  });

  it('forwards filtered pump records and { moment } to the pure module', function () {
    calls.length = 0;
    var now = Date.parse('2026-05-09T00:00:00Z');
    var inWindow = now - 60000;
    // urgentClock default is 30 → window = 60 min back
    var sbx = {
      time: now
      , data: { devicestatus: [
        { mills: inWindow, pump: { clock: '2026-05-09T00:00:00Z' } }   // KEEP
        , { mills: inWindow, loop: { timestamp: 'x' } }                // SKIP
        , { mills: now - 4 * 3600000, pump: { clock: 'old' } }         // SKIP
      ] }
      , entryMills: function (s) { return s.mills; }
      , extendedSettings: {}
      , settings: { dayStart: 6, dayEnd: 22 }
      , properties: {}
      , offerProperty: function (name, fn) { sbx.properties[name] = fn(); }
    };
    pump.setProperties(sbx);
    calls.length.should.equal(1);
    calls[0].records.length.should.equal(1);
    calls[0].records[0].pump.clock.should.equal('2026-05-09T00:00:00Z');
    (typeof calls[0].opts.moment).should.equal('function');
    sbx.properties.pump.should.have.property('data');
  });
});
