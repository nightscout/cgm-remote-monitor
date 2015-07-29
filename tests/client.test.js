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
      apiEnabled: true, careportalEnabled: true, enabledOptions: 'ar2 careportal delta direction upbat errorcodes', defaults: {
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
        , alarmTimeAgoWarn: true
        , alarmTimeAgoWarnMins: 15
        , alarmTimeAgoUrgent: true
        , alarmTimeAgoUrgentMins: 30
        , language: 'en'
        , showPlugins: 'iob delta direction upbatrawbg'
      }
      , units: 'mg/dl'
      , head: 'ae71dca'
      , version: '0.7.0'
      , thresholds: {
        bg_high: 200
        , bg_target_top: 170
        , bg_target_bottom: 80
        , bg_low: 55
      }
      , alarm_types: 'predict'
      , name: 'Nightscout'
    };

    var plugins = require('../lib/plugins/')().registerClientDefaults();
    var client = require('../lib/client');
    client.init(plugins, serverSettings);
  });

});
