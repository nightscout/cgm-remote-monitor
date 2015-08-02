'use strict';

require('should');

var benv = require('benv');

var serverSettings = {
  name: 'Nightscout'
  , version: '0.7.0'
  , apiEnabled: true
  , careportalEnabled: true
  , head: 'ae71dca'
  , settings: {
    units: 'mg/dl'
    , timeFormat: '12'
    , nightMode: false
    , showRawbg: 'noise'
    , customTitle: 'Nightscout'
    , theme: 'colors'
    , alarmUrgentHigh: true
    , alarmHigh: true
    , alarmLow: true
    , alarmUrgentLow: true
    , alarmTimeagoWarn: true
    , alarmTimeagoWarnMins: 15
    , alarmTimeagoUrgent: true
    , alarmTimeagoUrgentMins: 30
    , language: 'en'
    , enable: 'ar2 careportal delta direction upbat errorcodes'
    , showPlugins: 'iob delta direction upbatrawbg'
    , alarmTypes: 'predict'
    , thresholds: {
      bgHigh: 200
      , bgTargetTop: 170
      , bgTargetBottom: 80
      , bgLow: 55
    }
  }
};

var now = Date.now();

var updatedData = {
  sgvs: [
    { device: 'dexcom', mgdl: 100, mills: now, direction: 'Flat', type: 'sgv', filtered: 113984, unfiltered: 111920, rssi: 179, noise: 1
    }
  ], mbgs: [
    {mgdl: 100, mills: now}
  ], cals: [
    { device: 'dexcom',
      slope: 895.8571693029189,
      intercept: 34281.06876195567,
      scale: 1,
      type: 'cal'
    }
  ], devicestatus: {uploaderBattery: 100}, treatments: [
    {insulin: '1.00', mills: now}
  ]
};

describe('client', function ( ) {

  before(function (done) {
    benv.setup(function() {
      var $ = require('jquery');
      $('body').html('<div class="container"><div id="chartContainer"></div></div>');

      var d3 = require('d3');
      //disable all d3 transitions so most of the other code can run with jsdom
      d3.timer = function mockTimer() { };

      benv.expose({
        $: $
        , jQuery: $
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
    var client = benv.require('../lib/client');
    client.init(serverSettings, plugins);
    client.dataUpdate(updatedData);
  });


  it ('not blow up with mmol', function () {
    serverSettings.settings.units = 'mmol';

    var plugins = require('../lib/plugins/')().registerClientDefaults();
    var client = benv.require('../lib/client');
    client.init(serverSettings, plugins);
    client.dataUpdate(updatedData);
  });

});
