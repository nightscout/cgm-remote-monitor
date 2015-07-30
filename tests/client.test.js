'use strict';

require('should');

var benv = require('benv');

describe('client', function ( ) {

  before(function (done) {
    benv.setup(function() {
      benv.expose({
        $: require('jquery')
        , jQuery: require('jquery')
        , d3: require('d3')
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

  it ('not blow up', function () {
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

    var plugins = require('../lib/plugins/')().registerClientDefaults();
    var client = require('../lib/client');
    client.init(serverSettings, plugins);
  });

});
