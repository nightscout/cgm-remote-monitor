'use strict';

var _ = require('lodash');
var levels = require('./levels');
var constants = require('./constants.json');

function init () {

  var settings = {
    units: 'mg/dl'
    , timeFormat: 12
    , nightMode: false
    , editMode: true
    , showRawbg: 'never'
    , customTitle: 'Nightscout'
    , theme: 'default'
    , alarmUrgentHigh: true
    , alarmUrgentHighMins: [30, 60, 90, 120]
    , alarmHigh: true
    , alarmHighMins: [30, 60, 90, 120]
    , alarmLow: true
    , alarmLowMins: [15, 30, 45, 60]
    , alarmUrgentLow: true
    , alarmUrgentLowMins: [15, 30, 45]
    , alarmUrgentMins: [30, 60, 90, 120]
    , alarmWarnMins: [30, 60, 90, 120]
    , alarmTimeagoWarn: true
    , alarmTimeagoWarnMins: 15
    , alarmTimeagoUrgent: true
    , alarmTimeagoUrgentMins: 30
    , alarmPumpBatteryLow: false
    , language: 'en'
    , scaleY: 'log'
    , showPlugins: 'dbsize'
    , showForecast: 'ar2'
    , focusHours: 3
    , heartbeat: 60
    , baseURL: ''
    , authDefaultRoles: 'readable'
    , thresholds: {
      bgHigh: 260
      , bgTargetTop: 180
      , bgTargetBottom: 80
      , bgLow: 55
    }
    , insecureUseHttp: false
    , secureHstsHeader: true
    , secureHstsHeaderIncludeSubdomains: false
    , secureHstsHeaderPreload: false
    , secureCsp: false
    , deNormalizeDates: false
    , showClockDelta: false
    , showClockLastTime: false
    , bolusRenderOver: 1
    , frameUrl1: ''
    , frameUrl2: ''
    , frameUrl3: ''
    , frameUrl4: ''
    , frameUrl5: ''
    , frameUrl6: ''
    , frameUrl7: ''
    , frameUrl8: ''
    , frameName1: ''
    , frameName2: ''
    , frameName3: ''
    , frameName4: ''
    , frameName5: ''
    , frameName6: ''
    , frameName7: ''
    , frameName8: ''
  };

  var secureSettings = [
    'apnsKey'
    , 'apnsKeyId'
    , 'developerTeamId'
    , 'userName'
    , 'password'
  ];

  var valueMappers = {
    nightMode: mapTruthy
    , alarmUrgentHigh: mapTruthy
    , alarmUrgentHighMins: mapNumberArray
    , alarmHigh: mapTruthy
    , alarmHighMins: mapNumberArray
    , alarmLow: mapTruthy
    , alarmLowMins: mapNumberArray
    , alarmUrgentLow: mapTruthy
    , alarmUrgentLowMins: mapNumberArray
    , alarmUrgentMins: mapNumberArray
    , alarmTimeagoWarn: mapTruthy
    , alarmTimeagoUrgent: mapTruthy
    , alarmWarnMins: mapNumberArray
    , timeFormat: mapNumber
    , insecureUseHttp: mapTruthy
    , secureHstsHeader: mapTruthy
    , secureCsp: mapTruthy
    , deNormalizeDates: mapTruthy
    , showClockDelta: mapTruthy
    , showClockLastTime: mapTruthy
    , bgHigh: mapNumber
    , bgLow: mapNumber
    , bgTargetTop: mapNumber
    , bgTargetBottom: mapNumber
  };

  function filterObj(obj, secureKeys) {
    if (obj && typeof obj === 'object') {
        var allKeys = Object.keys(obj);
        for (var i = 0 ; i < allKeys.length ; i++) {
            var k = allKeys[i];
            if (secureKeys.includes(k)) {
              console.log('Deleting key', k);
              delete obj[k];
            } else {
             var value = obj[k];
             if ( typeof value === 'object') {
              filterObj(value, secureKeys);
             }
          }
        }
    }
    return obj;
  }

  function filteredSettings(settingsObject) {
    let so = _.cloneDeep(settingsObject);
    return filterObj(so, secureSettings);
  }

  function mapNumberArray (value) {
    if (!value || _.isArray(value)) {
      return value;
    }

    if (isNaN(value)) {
      var rawValues = value && value.split(' ') || [];
      return _.map(rawValues, function(num) {
        return isNaN(num) ? null : Number(num);
      });
    } else {
      return [Number(value)];
    }
  }

  function mapNumber (value) {
    if (!value) {
      return value;
    }

    if (typeof value === 'string' && isNaN(value)) {
      const decommaed = value.replace(',','.');
      if (!isNaN(decommaed)) { value = decommaed; }
    }

    if (isNaN(value)) {
      return value;
    } else {
      return Number(value);
    }
  }

  function mapTruthy (value) {
    if (typeof value === 'string' && (value.toLowerCase() === 'on' || value.toLowerCase() === 'true')) { value = true; }
    if (typeof value === 'string' && (value.toLowerCase() === 'off' || value.toLowerCase() === 'false')) { value = false; }
    return value;
  }

  //TODO: getting sent in status.json, shouldn't be
  settings.DEFAULT_FEATURES = ['bgnow', 'delta', 'direction', 'timeago', 'devicestatus', 'upbat', 'errorcodes', 'profile', 'dbsize'];

  var wasSet = [];

  function isSimple (value) {
    return _.isArray(value) || (typeof value !== 'function' && typeof value !== 'object');
  }

  function nameFromKey (key, nameType) {
    return nameType === 'env' ? _.snakeCase(key).toUpperCase() : key;
  }

  function eachSettingAs (nameType) {

    function mapKeys (accessor, keys) {
      _.forIn(keys, function each (value, key) {
        if (isSimple(value)) {
          var newValue = accessor(nameFromKey(key, nameType));
          if (newValue !== undefined) {
            var mapper = valueMappers[key];
            wasSet.push(key);
            keys[key] = mapper ? mapper(newValue) : newValue;
          }
        }
      });
    }

    return function allKeys (accessor) {
      mapKeys(accessor, settings);
      mapKeys(accessor, settings.thresholds);
      enableAndDisableFeatures(accessor, nameType);
    };
  }

  function enableAndDisableFeatures (accessor, nameType) {

    function getAndPrepare (key) {
      var raw = accessor(nameFromKey(key, nameType)) || '';
      var cleaned = decodeURIComponent(raw).toLowerCase();
      return cleaned ? cleaned.split(' ') : [];
    }

    function enableIf (feature, condition) {
      if (condition) {
        enable.push(feature);
      }
    }

    function anyEnabled (features) {
      return _.findIndex(features, function(feature) {
        return enable.indexOf(feature) > -1;
      }) > -1;
    }

    function prepareAlarmTypes () {
      var alarmTypes = _.filter(getAndPrepare('alarmTypes'), function onlyKnownTypes (type) {
        return type === 'predict' || type === 'simple';
      });

      if (alarmTypes.length === 0) {
        var thresholdWasSet = _.findIndex(wasSet, function(name) {
          return name.indexOf('bg') === 0;
        }) > -1;
        alarmTypes = thresholdWasSet ? ['simple'] : ['predict'];
      }

      return alarmTypes;
    }

    var enable = getAndPrepare('enable');
    var disable = getAndPrepare('disable');

    settings.alarmTypes = prepareAlarmTypes();

    //don't require pushover to be enabled to preserve backwards compatibility if there are extendedSettings for it
    enableIf('pushover', accessor(nameFromKey('pushoverApiToken', nameType)));

    enableIf('treatmentnotify', anyEnabled(['careportal', 'pushover', 'maker']));

    _.each(settings.DEFAULT_FEATURES, function eachDefault (feature) {
      enableIf(feature, enable.indexOf(feature) < 0);
    });

    //TODO: maybe get rid of ALARM_TYPES and only use enable?
    enableIf('simplealarms', settings.alarmTypes.indexOf('simple') > -1);
    enableIf('ar2', settings.alarmTypes.indexOf('predict') > -1);

    if (disable.length > 0) {
      console.info('disabling', disable);
    }

    //all enabled feature, without any that have been disabled
    settings.enable = _.difference(enable, disable);

    var thresholds = settings.thresholds;

    thresholds.bgHigh = Number(thresholds.bgHigh);
    thresholds.bgTargetTop = Number(thresholds.bgTargetTop);
    thresholds.bgTargetBottom = Number(thresholds.bgTargetBottom);
    thresholds.bgLow = Number(thresholds.bgLow);

    // Do not convert for old installs that have these set in mg/dl
    if (settings.units.toLowerCase().includes('mmol') && thresholds.bgHigh < 50) {
      thresholds.bgHigh = Math.round(thresholds.bgHigh * constants.MMOL_TO_MGDL);
      thresholds.bgTargetTop = Math.round(thresholds.bgTargetTop * constants.MMOL_TO_MGDL);
      thresholds.bgTargetBottom = Math.round(thresholds.bgTargetBottom * constants.MMOL_TO_MGDL);
      thresholds.bgLow = Math.round(thresholds.bgLow * constants.MMOL_TO_MGDL);
    }

    verifyThresholds();
    adjustShownPlugins();
  }

  function verifyThresholds () {
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

  function adjustShownPlugins () {
    var showPluginsUnset = settings.showPlugins && 0 === settings.showPlugins.length;

    settings.showPlugins += ' delta direction upbat';
    if (settings.showRawbg === 'always' || settings.showRawbg === 'noise') {
      settings.showPlugins += ' rawbg';
    }

    if (showPluginsUnset) {
      //assume all enabled features are plugins and they should be shown for now
      //it would be better to use the registered plugins, but it's not loaded yet...
      _.forEach(settings.enable, function showFeature (feature) {
        if (isEnabled(feature)) {
          settings.showPlugins += ' ' + feature;
        }
      });
    }
  }

  function isEnabled (feature) {
    var enabled = false;

    if (settings.enable && typeof feature === 'object' && feature.length !== undefined) {
      enabled = _.find(feature, function eachFeature (f) {
        return settings.enable.indexOf(f) > -1;
      }) !== undefined;
    } else {
      enabled = settings.enable && settings.enable.indexOf(feature) > -1;
    }

    return enabled;
  }

  function isUrgentHighAlarmEnabled(notify) {
    return notify.eventName === 'high' && notify.level === levels.URGENT && settings.alarmUrgentHigh;
  }

  function isHighAlarmEnabled(notify) {
    return notify.eventName === 'high' && settings.alarmHigh;
  }

  function isUrgentLowAlarmEnabled(notify) {
    return notify.eventName === 'low' && notify.level === levels.URGENT && settings.alarmUrgentLow;
  }

  function isLowAlarmEnabled(notify) {
    return notify.eventName === 'low' && settings.alarmLow;
  }

  function isAlarmEventEnabled (notify) {
    return ('high' !== notify.eventName && 'low' !== notify.eventName)
     || isUrgentHighAlarmEnabled(notify)
     || isHighAlarmEnabled(notify)
     || isUrgentLowAlarmEnabled(notify)
     || isLowAlarmEnabled(notify);
  }

  function snoozeMinsForAlarmEvent (notify) {
    var snoozeTime;

    if (isUrgentHighAlarmEnabled(notify)) {
      snoozeTime = settings.alarmUrgentHighMins;
    } else if (isHighAlarmEnabled(notify)) {
      snoozeTime = settings.alarmHighMins;
    } else if (isUrgentLowAlarmEnabled(notify)) {
      snoozeTime = settings.alarmUrgentLowMins;
    } else if (isLowAlarmEnabled(notify)) {
      snoozeTime = settings.alarmLowMins;
    } else if (notify.level === levels.URGENT) {
      snoozeTime = settings.alarmUrgentMins;
    } else {
      snoozeTime = settings.alarmWarnMins;
    }

    return snoozeTime;
  }

  function snoozeFirstMinsForAlarmEvent (notify) {
    return _.first(snoozeMinsForAlarmEvent(notify));
  }

  settings.eachSetting = eachSettingAs();
  settings.eachSettingAsEnv = eachSettingAs('env');
  settings.isEnabled = isEnabled;
  settings.isAlarmEventEnabled = isAlarmEventEnabled;
  settings.snoozeMinsForAlarmEvent = snoozeMinsForAlarmEvent;
  settings.snoozeFirstMinsForAlarmEvent = snoozeFirstMinsForAlarmEvent;
  settings.filteredSettings = filteredSettings;

  return settings;

}

module.exports = init;
