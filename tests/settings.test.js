'use strict';

var _ = require('lodash');
var should = require('should');
var levels = require('../lib/levels');

describe('settings', function ( ) {
  var settings = require('../lib/settings')();

  it('have defaults ready', function () {
    settings.timeFormat.should.equal('12');
    settings.nightMode.should.equal(false);
    settings.showRawbg.should.equal('never');
    settings.customTitle.should.equal('Nightscout');
    settings.theme.should.equal('default');
    settings.alarmUrgentHigh.should.equal(true);
    settings.alarmUrgentHighMins.should.eql([30, 60, 90, 120]);
    settings.alarmHigh.should.equal(true);
    settings.alarmHighMins.should.eql([30, 60, 90, 120]);
    settings.alarmLow.should.equal(true);
    settings.alarmLowMins.should.eql([15, 30, 45, 60]);
    settings.alarmUrgentLow.should.equal(true);
    settings.alarmUrgentLowMins.should.eql([15, 30, 45]);
    settings.alarmUrgentMins.should.eql([30, 60, 90, 120]);
    settings.alarmWarnMins.should.eql([30, 60, 90, 120]);
    settings.alarmTimeagoWarn.should.equal(true);
    settings.alarmTimeagoWarnMins.should.equal(15);
    settings.alarmTimeagoUrgent.should.equal(true);
    settings.alarmTimeagoUrgentMins.should.equal(30);
    settings.language.should.equal('en');
    settings.showPlugins.should.equal('');
  });

  it('support setting from env vars', function () {
    var expected = [
      'ENABLE'
      , 'DISABLE'
      , 'UNITS'
      , 'TIME_FORMAT'
      , 'NIGHT_MODE'
      , 'SHOW_RAWBG'
      , 'CUSTOM_TITLE'
      , 'THEME'
      , 'ALARM_TYPES'
      , 'ALARM_URGENT_HIGH'
      , 'ALARM_HIGH'
      , 'ALARM_LOW'
      , 'ALARM_URGENT_LOW'
      , 'ALARM_TIMEAGO_WARN'
      , 'ALARM_TIMEAGO_WARN_MINS'
      , 'ALARM_TIMEAGO_URGENT'
      , 'ALARM_TIMEAGO_URGENT_MINS'
      , 'LANGUAGE'
      , 'SHOW_PLUGINS'
      , 'BG_HIGH'
      , 'BG_TARGET_TOP'
      , 'BG_TARGET_BOTTOM'
      , 'BG_LOW'
    ];

    expected.length.should.equal(23);

    var seen = { };
    settings.eachSettingAsEnv(function markSeenNames(name) {
      seen[name] = true;
    });


    var expectedAndSeen = _.filter(expected, function (name) {
      return seen[name];
    });

    expectedAndSeen.length.should.equal(expected.length);
  });

  it('support setting each', function () {
    var expected = [
      'enable'
      , 'disable'
      , 'units'
      , 'timeFormat'
      , 'nightMode'
      , 'showRawbg'
      , 'customTitle'
      , 'theme'
      , 'alarmTypes'
      , 'alarmUrgentHigh'
      , 'alarmHigh'
      , 'alarmLow'
      , 'alarmUrgentLow'
      , 'alarmTimeagoWarn'
      , 'alarmTimeagoWarnMins'
      , 'alarmTimeagoUrgent'
      , 'alarmTimeagoUrgentMins'
      , 'language'
      , 'showPlugins'
    ];

    expected.length.should.equal(19);

    var seen = { };
    settings.eachSetting(function markSeenNames(name) {
      seen[name] = true;
    });


    var expectedAndSeen = _.filter(expected, function (name) {
      return seen[name];
    });

    expectedAndSeen.length.should.equal(expected.length);

  });

  it('have default features', function () {
    var fresh = require('../lib/settings')();
    fresh.eachSettingAsEnv(function () {
      return undefined;
    });

    _.each(fresh.DEFAULT_FEATURES, function eachDefault (feature) {
      fresh.enable.should.containEql(feature);
    });

  });

  it('support disabling default features', function () {
    var fresh = require('../lib/settings')();
    fresh.eachSettingAsEnv(function (name) {
      return name === 'DISABLE' ?
        fresh.DEFAULT_FEATURES.join(' ') + ' ar2' //need to add ar2 here since it will be auto enabled
        : undefined;
    });

    fresh.enable.length.should.equal(0);
  });

  it('parse custom snooze mins', function () {
    var userSetting = {
      ALARM_URGENT_LOW_MINS: '5 10 15'
    };

    var fresh = require('../lib/settings')();
    fresh.eachSettingAsEnv(function (name) {
      return userSetting[name];
    });

    fresh.alarmUrgentLowMins.should.eql([5, 10, 15]);

    fresh.snoozeMinsForAlarmEvent({eventName: 'low', level: levels.URGENT}).should.eql([5, 10, 15]);
    fresh.snoozeFirstMinsForAlarmEvent({eventName: 'low', level: levels.URGENT}).should.equal(5);
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

    fresh.thresholds.bgHigh.should.equal(200);
    fresh.thresholds.bgTargetTop.should.equal(170);
    fresh.thresholds.bgTargetBottom.should.equal(70);
    fresh.thresholds.bgLow.should.equal(60);

    should.deepEqual(fresh.alarmTypes, ['simple']);
  });

  it('default to predict if no thresholds are set', function () {
    var fresh = require('../lib/settings')();
    fresh.eachSettingAsEnv(function ( ) {
      return undefined;
    });

    should.deepEqual(fresh.alarmTypes, ['predict']);
  });

  it('ignore junk alarm types', function () {
    var fresh = require('../lib/settings')();
    fresh.eachSettingAsEnv(function (name) {
      return name === 'ALARM_TYPES' ? 'beep bop' : undefined;
    });

    should.deepEqual(fresh.alarmTypes, ['predict']);
  });

  it('allow multiple alarm types to be set', function () {
    var fresh = require('../lib/settings')();
    fresh.eachSettingAsEnv(function (name) {
      return name === 'ALARM_TYPES' ? 'predict simple' : undefined;
    });

    should.deepEqual(fresh.alarmTypes, ['predict', 'simple']);
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

    fresh.thresholds.bgHigh.should.equal(91);
    fresh.thresholds.bgTargetTop.should.equal(90);
    fresh.thresholds.bgTargetBottom.should.equal(89);
    fresh.thresholds.bgLow.should.equal(88);

    should.deepEqual(fresh.alarmTypes, ['simple']);
  });

  it('check if a feature isEnabled', function () {
    var fresh = require('../lib/settings')();
    fresh.enable = ['feature1'];
    fresh.isEnabled('feature1').should.equal(true);
    fresh.isEnabled('feature2').should.equal(false);
  });

  it('check if any listed feature isEnabled', function () {
    var fresh = require('../lib/settings')();
    fresh.enable = ['feature1'];
    fresh.isEnabled(['unknown', 'feature1']).should.equal(true);
    fresh.isEnabled(['unknown', 'feature2']).should.equal(false);
  });

});
