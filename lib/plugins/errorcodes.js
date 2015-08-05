'use strict';

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

  //TODO: move notification levels to constants
  var code2Level = {
    5: levels.INFO
    , 9: levels.URGENT
    , 10: levels.URGENT
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

    if (lastSGV && now - lastSGV.mills < times.mins(10).msecs && lastSGV.mgdl < 39) {

      var errorDisplay = toDisplay(lastSGV.mgdl);
      var pushoverSound = code2PushoverSound[lastSGV.mgdl] || null;
      var notifyLevel = code2Level[lastSGV.mgdl] || levels.LOW;

      if (notifyLevel > levels.NONE) {
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


  return errorcodes;

}

module.exports = init;