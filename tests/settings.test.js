'use strict';

var should = require('should');
var levels = require('../lib/levels');

describe('settings', function ( ) {
  var settings = require('../lib/settings')();

  it('have defaults ready', function () {
    settings.timeFormat.should.equal(12);
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
    settings.showPlugins.should.equal('dbsize');
    settings.insecureUseHttp.should.equal(false);
    settings.secureHstsHeader.should.equal(true);
    settings.secureCsp.should.equal(false);
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
      , 'SCALE_Y'
    ];

    expected.length.should.equal(24);

    var seen = { };
    settings.eachSettingAsEnv(function markSeenNames(name) {
      seen[name] = true;
    });


    var expectedAndSeen = expected.filter(function (name) {
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


    var expectedAndSeen = expected.filter(function (name) {
      return seen[name];
    });

    expectedAndSeen.length.should.equal(expected.length);

  });

  it('support setting numbered camel-case env vars', function () {
    var userSetting = {
      SHOW_RAWBG: 'always'
      , SECURE_CSP: 'true'
    };

    for (var i = 1; i <= 8; i++) {
      userSetting['FRAME_URL_' + i] = 'https://example' + i + '.com';
      userSetting['FRAME_NAME_' + i] = 'Site ' + i;
    }

    var fresh = require('../lib/settings')();
    fresh.eachSettingAsEnv(function (name) {
      return userSetting[name];
    });

    for (var frameIndex = 1; frameIndex <= 8; frameIndex++) {
      fresh['frameUrl' + frameIndex].should.equal('https://example' + frameIndex + '.com');
      fresh['frameName' + frameIndex].should.equal('Site ' + frameIndex);
    }
    fresh.showRawbg.should.equal('always');
    fresh.secureCsp.should.equal(true);
  });

  it('support setting numbered custom webhook env vars', function () {
    var userSetting = {
      CUSTOM_WEBHOOK_URL_1: 'https://one.example.com/hook'
      , CUSTOM_WEBHOOK_EVENT_1: 'ns-urgent'
      //sparse on purpose, index 3 is set while index 2 is left unconfigured
      , CUSTOM_WEBHOOK_URL_3: 'http://three.example.com/hook'
      , CUSTOM_WEBHOOK_EVENT_3: 'ns-allclear'
    };

    var fresh = require('../lib/settings')();
    fresh.eachSettingAsEnv(function (name) {
      return userSetting[name];
    });

    fresh.customWebhookUrl1.should.equal('https://one.example.com/hook');
    fresh.customWebhookEvent1.should.equal('ns-urgent');
    fresh.customWebhookUrl2.should.equal('');
    fresh.customWebhookEvent2.should.equal('');
    fresh.customWebhookUrl3.should.equal('http://three.example.com/hook');
    fresh.customWebhookEvent3.should.equal('ns-allclear');
  });

  it('does not publish custom webhook urls in filtered settings', function () {
    var userSetting = {
      CUSTOM_WEBHOOK_URL_1: 'https://one.example.com/hook?token=SUPERSECRET'
      , CUSTOM_WEBHOOK_EVENT_1: 'ns-urgent'
    };

    var fresh = require('../lib/settings')();
    fresh.eachSettingAsEnv(function (name) {
      return userSetting[name];
    });

    var published = fresh.filteredSettings(fresh);

    should.not.exist(published.customWebhookUrl1);
    JSON.stringify(published).indexOf('SUPERSECRET').should.equal(-1);
    //the event name is not a secret and stays available to the client
    published.customWebhookEvent1.should.equal('ns-urgent');
  });

  it('have default features', function () {
    var fresh = require('../lib/settings')();
    fresh.eachSettingAsEnv(function () {
      return undefined;
    });

    fresh.DEFAULT_FEATURES?.forEach(function eachDefault (feature) {
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
