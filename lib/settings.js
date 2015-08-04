'use strict';

var _ = require('lodash');

function init ( ) {

  var settings = {
    units: 'mg/dL'
    , timeFormat: '12'
    , nightMode: false
    , showRawbg: 'never'
    , customTitle: 'Nightscout'
    , theme: 'default'
    , alarmUrgentHigh: true
    , alarmTypes: 'predict'
    , alarmHigh: true
    , alarmLow: true
    , alarmUrgentLow: true
    , alarmTimeagoWarn: true
    , alarmTimeagoWarnMins: 15
    , alarmTimeagoUrgent: true
    , alarmTimeagoUrgentMins: 30
    , language: 'en'
    , showPlugins: ''
    , thresholds: {
      bgHigh: 260
      , bgTargetTop: 180
      , bgTargetBottom: 80
      , bgLow: 55
    }
  };

  var wasSet = [];

  function isSimple (value) {
    return typeof value !== 'function' && typeof value !== 'object';
  }

  function eachSettingAs (nameType) {
    function topKeys (setter, keys) {
      _.forIn(keys, function each (value, key) {
        if (isSimple(value)) {
          var name = nameType === 'env' ? _.snakeCase(key).toUpperCase() : key;
          var newValue = setter(name);
          if (newValue !== undefined) {
            wasSet.push(key);
            keys[key] = setter(name);
          }
        }
      });
    }

    return function allKeys (setter) {
      topKeys(setter, settings);

      //for env vars thresholds are at the top level, they aren't set on the client (yet)
      if (nameType === 'env') {
        topKeys(setter, settings.thresholds);
      }
    };
  }

  function adjustShownPlugins ( ) {
    //TODO: figure out something for some plugins to have them shown by default
    if (settings.showPlugins !== '') {
      settings.showPlugins += ' delta direction upbat';
      if (settings.showRawbg === 'always' || settings.showRawbg === 'noise') {
        settings.showPlugins += ' rawbg';
      }
    }
  }

  function adjustAlarmTypes ( ) {
    //if any threshold was set, and alarm types was not set default to simple
    if (wasSet.indexOf('alarmTypes') === -1) {
      var thresholdWasSet = _.findIndex(wasSet, function (name) {
        return name.indexOf('bg') === 0;
      }) > -1;
      settings.alarmTypes = thresholdWasSet ? 'simple' : 'predict';
    }
  }

  function verifyThresholds() {
    var thresholds = settings.thresholds;

    if (thresholds.bgTargetBottom >= thresholds.bgTargetTop) {
      console.warn('BG_TARGET_BOTTOM(' + thresholds.bgTargetBottom + ') was >= BG_TARGET_TOP(' + thresholds.bgTargetTop + ')');
      thresholds.bgTargetBottom = thresholds.bgTargetTop - 1;
      console.warn('BG_TARGET_BOTTOM is now ' + thresholds.bgTargetBottom);
    }
    if (thresholds.bgTargetTop <= thresholds.bgTargetBottom) {
      console.warn('BG_TARGET_TOP(' + thresholds.bgTargetTop + ') was <= BG_TARGET_BOTTOM(' + thresholds.bgTargetBottom + ')');
      thresholds.bgTargetTop = thresholds.bgTargetBottom + 1;
      console.warn('BG_TARGET_TOP is now ' + thresholds.bgTargetTop);
    }
    if (thresholds.bgLow >= thresholds.bgTargetBottom) {
      console.warn('BG_LOW(' + thresholds.bgLow + ') was >= BG_TARGET_BOTTOM(' + thresholds.bgTargetBottom + ')');
      thresholds.bgLow = thresholds.bgTargetBottom - 1;
      console.warn('BG_LOW is now ' + thresholds.bgLow);
    }
    if (thresholds.bgHigh <= thresholds.bgTargetTop) {
      console.warn('BG_HIGH(' + thresholds.bgHigh + ') was <= BG_TARGET_TOP(' + thresholds.bgTargetTop + ')');
      thresholds.bgHigh = thresholds.bgTargetTop + 1;
      console.warn('BG_HIGH is now ' + thresholds.bgHigh);
    }
  }

  settings.processRawSettings = function processRawSettings ( ) {
    var thresholds = settings.thresholds;

    thresholds.bgHigh = Number(thresholds.bgHigh);
    thresholds.bgTargetTop = Number(thresholds.bgTargetTop);
    thresholds.bgTargetBottom = Number(thresholds.bgTargetBottom);
    thresholds.bgLow = Number(thresholds.bgLow);

    verifyThresholds();
    adjustShownPlugins();
    adjustAlarmTypes();
  };

  function isEnabled (feature) {
    return settings.enable && settings.enable.indexOf(feature) > -1;
  }

  settings.eachSetting = eachSettingAs();
  settings.eachSettingAsEnv = eachSettingAs('env');
  settings.isEnabled = isEnabled;

  return settings;

}

module.exports = init;