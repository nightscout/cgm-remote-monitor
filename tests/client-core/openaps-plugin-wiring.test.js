'use strict';
require('should');
var path = require('path');

var SELECT_PATH = require.resolve('../../lib/client-core/devicestatus/openaps');
var calls = [];
var stub = function (records, recent, opts) {
  calls.push({ records: records, recent: recent, opts: opts });
  return {
    seenDevices: {}
    , lastEnacted: null
    , lastNotEnacted: null
    , lastSuggested: null
    , lastIOB: null
    , lastMMTune: null
    , lastPredBGs: null
    , status: { symbol: '?', code: 'waiting', label: 'Waiting' }
  };
};
stub.selectOpenAPSState = stub;

// Install BEFORE requiring lib/plugins/openaps so the plugin picks up the stub.
require.cache[SELECT_PATH] = { id: SELECT_PATH, filename: SELECT_PATH, loaded: true, exports: stub };

// Also clear the plugin cache in case a prior test loaded it.
var PLUGIN_PATH = require.resolve('../../lib/plugins/openaps');
delete require.cache[PLUGIN_PATH];

var moment = require('moment');
var levels = require('../../lib/levels');
var language = require('../../lib/language')(require('fs'));
language.set('en');
var ctx = { language: language, settings: { units: 'mg/dl' }, levels: levels, moment: moment };
var openaps = require(PLUGIN_PATH)(ctx);


describe('plugin wiring: openaps.analyzeData → selectOpenAPSState', function () {
  after(function () {
    delete require.cache[SELECT_PATH];
    delete require.cache[PLUGIN_PATH];
  });

  it('forwards (recentData, recent, { moment, deviceName }) to the pure module', function () {
    calls.length = 0;
    var now = Date.parse('2026-05-09T00:00:00Z');
    var sbx = {
      time: now
      , data: { devicestatus: [
        { mills: now - 60000, device: 'openaps://test', openaps: { suggested: { timestamp: 'x' } } }
        , { mills: now - 60000, device: 'openaps://test' }
      ] }
      , entryMills: function (s) { return s.mills; }
      , extendedSettings: {}
    };
    openaps.analyzeData(sbx);
    calls.length.should.equal(1);
    calls[0].records.length.should.equal(1);
    moment.isMoment(calls[0].recent).should.be.true();
    (typeof calls[0].opts.moment).should.equal('function');
    (typeof calls[0].opts.deviceName).should.equal('function');
  });
});
