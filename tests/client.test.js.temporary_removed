'use strict';

require('should');
var times = require('../lib/times');
var benv = require('benv');
var read = require('fs').readFileSync;
var serverSettings = require('./fixtures/default-server-settings');

var TEST_TITLE = 'Test Title';

var stored = { };
var removed = { };

var now = Date.now();
var next = Date.now() + times.mins(5).msecs;

var nowData = {
  sgvs: [
    { device: 'dexcom', mgdl: 100, mills: now, direction: 'Flat', type: 'sgv', filtered: 113984, unfiltered: 111920, rssi: 179, noise: 1 }
  ], mbgs: [
    { mgdl: 100, mills: now }
  ], cals: [
    {
      device: 'dexcom'
      , slope: 895.8571693029189
      , intercept: 34281.06876195567
      , scale: 1
      , type: 'cal'
    }
  ], devicestatus: { uploaderBattery: 100 }
  , treatments: [
    {
      eventType: 'Snack Bolus'
      , insulin: '1.00'
      , carbs: '18'
      , mills: now
    }
  ]
};

var nextData = {
  sgvs: [
    { device: 'dexcom', mgdl: 101, mills: next, direction: 'Flat', type: 'sgv', filtered: 113984, unfiltered: 111920, rssi: 179, noise: 1 }
  ], mbgs: [ ]
  , cals: []
  , devicestatus: { uploaderBattery: 100 }
  , treatments: []
};

describe('client', function ( ) {
  var self = this;
  before(function (done) {
    benv.setup(function() {
      self.$ = require('jquery');
      self.$.localStorage = {
        get: function mockGet (name) {
          return name === 'alarmTimeagoWarnMins' ? 99 : undefined;
        }
        , set: function mockSet (name, value) {
          stored[name] = value;
        }
        , remove: function mockRemove (name) {
          removed[name] = true;
        }
      };

      self.$.fn.tipsy = function mockTipsy ( ) { };

      var indexHtml = read(__dirname + '/../static/index.html', 'utf8');
      self.$('body').html(indexHtml);

      var d3 = require('d3');
      //disable all d3 transitions so most of the other code can run with jsdom
      d3.timer = function mockTimer() { };

      benv.expose({
        $: self.$
        , jQuery: self.$
        , d3: d3
        , io: {
          connect: function mockConnect ( ) {
            return {
              on: function mockOn ( ) { }
            };
          }
        }
      });
      done();
    });
  });

  after(function (done) {
    benv.teardown();
    done();
  });

  it ('not blow up with mg/dl', function () {
    var plugins = require('../lib/plugins/')().registerClientDefaults();
    var client = require('../lib/client');
    client.init(serverSettings, plugins);
    client.dataUpdate(nowData);
  });

  it ('handle 2 updates', function () {
    var plugins = require('../lib/plugins/')().registerClientDefaults();
    var client = require('../lib/client');
    client.init(serverSettings, plugins);
    client.dataUpdate(nowData);
    client.dataUpdate(nextData);
  });

  it ('not blow up with mmol', function () {
    serverSettings.settings.units = 'mmol';
    serverSettings.settings.timeFormat = 24;

    var plugins = require('../lib/plugins/')().registerClientDefaults();
    var client = require('../lib/client');
    client.init(serverSettings, plugins);
    client.dataUpdate(nowData);
  });

  it ('load, store, and clear settings', function () {
    var plugins = require('../lib/plugins/')().registerClientDefaults();
    var client = require('../lib/client');
    client.init(serverSettings, plugins);
    client.dataUpdate(nowData);

    var browserSettings = require('../lib/client/browser-settings')(client, plugins, serverSettings, self.$);
    browserSettings.alarmTimeagoWarnMins.should.equal(99);
    browserSettings.customTitle.should.equal(TEST_TITLE);

    self.$('#save').click();
    stored.customTitle.should.equal(TEST_TITLE);
    self.$('#useDefaults').click();
    removed.customTitle.should.equal(true);
  });

});
