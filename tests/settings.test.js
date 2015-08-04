'use strict';

require('should');
var _ = require('lodash');

describe('settings', function ( ) {
  var settings = require('../lib/settings')();

  it('have defaults ready', function () {
    settings.units.should.equal('mg/dL');
    settings.timeFormat.should.equal('12');
    settings.nightMode.should.equal(false);
    settings.showRawbg.should.equal('never');
    settings.customTitle.should.equal('Nightscout');
    settings.theme.should.equal('default');
    settings.alarmTypes.should.equal('predict');
    settings.alarmUrgentHigh.should.equal(true);
    settings.alarmHigh.should.equal(true);
    settings.alarmLow.should.equal(true);
    settings.alarmUrgentLow.should.equal(true);
    settings.alarmTimeagoWarn.should.equal(true);
    settings.alarmTimeagoWarnMins.should.equal(15);
    settings.alarmTimeagoUrgent.should.equal(true);
    settings.alarmTimeagoUrgentMins.should.equal(30);
    settings.language.should.equal('en');
    settings.showPlugins.should.equal('');
  });

  it('support setting from env vars', function () {
    var expected = {
      DISPLAY_UNITS: false
      , TIME_FORMAT: false
      , NIGHT_MODE: false
      , SHOW_RAWBG: false
      , CUSTOM_TITLE: false
      , THEME: false
      , ALARM_TYPES: false
      , ALARM_URGENT_HIGH: false
      , ALARM_HIGH: false
      , ALARM_LOW: false
      , ALARM_URGENT_LOW: false
      , ALARM_TIMEAGO_WARN: false
      , ALARM_TIMEAGO_WARN_MINS: false
      , ALARM_TIMEAGO_URGENT: false
      , ALARM_TIMEAGO_URGENT_MINS: false
      , LANGUAGE: false
      , SHOW_PLUGINS: false
      , BG_HIGH: false
      , BG_TARGET_TOP: false
      , BG_TARGET_BOTTOM: false
      , BG_LOW: false

    };

    var expectedKeys = _.keys(expected);
    expectedKeys.length.should.equal(21);

    settings.eachSettingAsEnv(function markSeenNames(name) {
      expected[name] = true;
    });


    var filtered = _.filter(expected, function (value) {
      return value;
    });

    filtered.length.should.equal(expectedKeys.length);
  });

  it('support setting each', function () {
    var expected = {
      units: false
      , timeFormat: false
      , nightMode: false
      , showRawbg: false
      , customTitle: false
      , theme: false
      , alarmTypes: false
      , alarmUrgentHigh: false
      , alarmHigh: false
      , alarmLow: false
      , alarmUrgentLow: false
      , alarmTimeagoWarn: false
      , alarmTimeagoWarnMins: false
      , alarmTimeagoUrgent: false
      , alarmTimeagoUrgentMins: false
      , language: false
      , showPlugins: false
    };

    var expectedKeys = _.keys(expected);
    expectedKeys.length.should.equal(17);

    settings.eachSetting(function markSeenNames(name) {
      expected[name] = true;
    });

    var filtered = _.filter(expected, function (value) {
      return value;
    });

    filtered.length.should.equal(expectedKeys.length);
  });

  it('set thresholds', function () {
    var userThresholds = {
      BG_HIGH: '200'
      , BG_TARGET_TOP: '170'
      , BG_TARGET_BOTTOM: '70'
      , BG_LOW: '60'
    };

    var fresh = require('../lib/settings')();
    fresh.eachSettingAsEnv(function (name) {
      return userThresholds[name];
    });

    fresh.processRawSettings();

    fresh.thresholds.bgHigh.should.equal(200);
    fresh.thresholds.bgTargetTop.should.equal(170);
    fresh.thresholds.bgTargetBottom.should.equal(70);
    fresh.thresholds.bgLow.should.equal(60);

    fresh.alarmTypes.should.equal('simple');
  });

  it('default to predict if no thresholds are set', function () {
    var fresh = require('../lib/settings')();
    fresh.processRawSettings();
    fresh.alarmTypes.should.equal('predict');
  });

  it('handle screwed up thresholds in a way that will display something that looks wrong', function () {
    var screwedUp = {
      BG_HIGH: '89'
      , BG_TARGET_TOP: '90'
      , BG_TARGET_BOTTOM: '95'
      , BG_LOW: '96'
    };

    var fresh = require('../lib/settings')();
    fresh.eachSettingAsEnv(function (name) {
      return screwedUp[name];
    });

    fresh.processRawSettings();

    fresh.thresholds.bgHigh.should.equal(91);
    fresh.thresholds.bgTargetTop.should.equal(90);
    fresh.thresholds.bgTargetBottom.should.equal(89);
    fresh.thresholds.bgLow.should.equal(88);

    fresh.alarmTypes.should.equal('simple');
  });

});
