'use strict';

var _ = require('lodash');
var levels = require('../levels');
var times = require('../times');

function init() {

  var errorcodes = {
    name: 'errorcodes'
    , label: 'Dexcom Error Codes'
    , pluginType: 'notification'
  };

  var code2Display = {
    1: '?SN' //SENSOR_NOT_ACTIVE
    , 2: '?MD' //MINIMAL_DEVIATION
    , 3: '?NA' //NO_ANTENNA
    , 5: '?NC' //SENSOR_NOT_CALIBRATED
    , 6: '?CD' //COUNTS_DEVIATION
    , 9: '?AD' //ABSOLUTE_DEVIATION
    , 10: '???' //POWER_DEVIATION
    , 12: '?RF' //BAD_RF
  };

  var code2PushoverSound = {
    5: 'intermission'
    , 9: 'alien'
    , 10: 'alien'
  };

  function toDisplay (errorCode) {
    return code2Display[errorCode] || errorCode + '??';
  }

  errorcodes.toDisplay = toDisplay;

  errorcodes.checkNotifications = function checkNotifications (sbx) {
    var now = Date.now();
    var lastSGV = sbx.lastSGVEntry();

    var code2Level = buildMappingFromSettings(sbx.extendedSettings);

    if (lastSGV && now - lastSGV.mills < times.mins(10).msecs && lastSGV.mgdl < 39) {
      var errorDisplay = toDisplay(lastSGV.mgdl);
      var pushoverSound = code2PushoverSound[lastSGV.mgdl] || null;
      var notifyLevel = code2Level[lastSGV.mgdl];

      if (notifyLevel !== undefined) {
        sbx.notifications.requestNotify({
          level: notifyLevel
          , title: 'CGM Error Code'
          , message: errorDisplay
          , plugin: errorcodes
          , pushoverSound: pushoverSound
          , debug: {
            lastSGV: lastSGV
          }
        });
      }

    }
  };

  function buildMappingFromSettings (extendedSettings) {
    var mapping = {};

    function addValuesToMapping (value, level) {
      if (!value || !value.split) {
        return [];
      }

      var rawValues = value && value.split(' ') || [];
      _.each(rawValues, function (num) {
        if (!isNaN(num)) {
          mapping[Number(num)] = level;
        }
      });
    }

    addValuesToMapping(extendedSettings.info || '1 2 3 4 5 6 7 8', levels.INFO);
    addValuesToMapping(extendedSettings.warn || false, levels.WARN);
    addValuesToMapping(extendedSettings.urgent || '9 10', levels.URGENT);

    return mapping;
  }

  //for tests
  errorcodes.buildMappingFromSettings = buildMappingFromSettings;


  return errorcodes;

}

module.exports = init;