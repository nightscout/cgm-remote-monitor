'use strict';

var _ = require('lodash');

function init() {

  var TIME_10_MINS_MS = 10 * 60 * 1000;

  function errorcodes() {
    return errorcodes;
  }

  errorcodes.label = 'Dexcom Error Codes';
  errorcodes.pluginType = 'notification';

  errorcodes.checkNotifications = function checkNotifications (sbx) {
    var now = Date.now();
    var lastSGV = _.last(sbx.data.sgvs);

    if (lastSGV && now - lastSGV.x < TIME_10_MINS_MS && lastSGV.y < 39) {

      var errorDisplay;
      var pushoverSound = null;
      var notifyLevel = sbx.notifications.levels.LOW;

      switch (parseInt(lastSGV.y)) {
        case 0: //None
          errorDisplay = '??0';
          break;
        case 1: //SENSOR_NOT_ACTIVE
          errorDisplay = '?SN';
          break;
        case 2: //MINIMAL_DEVIATION
          errorDisplay = '??2';
          break;
        case 3: //NO_ANTENNA
          errorDisplay = '?NA';
          break;
        case 5: //SENSOR_NOT_CALIBRATED
          errorDisplay = '?NC';
          break;
        case 6: //COUNTS_DEVIATION
          errorDisplay = '?CD';
          break;
        case 7: //?
          errorDisplay = '??7';
          break;
        case 8: //?
          errorDisplay = '??8';
          break;
        case 9: //ABSOLUTE_DEVIATION
          errorDisplay = '?AD';
          pushoverSound = 'alien';
          notifyLevel = sbx.notifications.levels.URGENT;
          break;
        case 10: //POWER_DEVIATION
          errorDisplay = '???';
          pushoverSound = 'alien';
          notifyLevel = sbx.notifications.levels.URGENT;
          break;
        case 12: //BAD_RF
          errorDisplay = '?RF';
          break;
        default:
          notifyLevel = sbx.notifications.levels.LOWEST;
          errorDisplay = '?' + parseInt(lastSGV.y) + '?';
          break;
      }

      if (notifyLevel > sbx.notifications.levels.NONE) {
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


  return errorcodes();

}

module.exports = init;