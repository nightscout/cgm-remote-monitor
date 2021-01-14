'use strict';

var _ = require('lodash');
var moment = require('moment');
var times = require('../times');
var levels = require('../levels');

function init (ctx) {
  var utils = require('../utils')(ctx);
  var firstPrefs = true;
  var lastStateNotification = null;
  var translate = ctx.language.translate;

  var guardianconnect = {
    name: 'guardianconnect'
    , label: 'Guardian Connect'
    , pluginType: 'pill-status'
  };

  guardianconnect.getPrefs = function getPrefs (sbx) {
    var prefs = {
      enableAlerts: sbx.extendedSettings.enableAlerts || true
      , warnGCBat: sbx.extendedSettings.warnGCBat || 50
      , urgentGCBat: sbx.extendedSettings.urgentGCBat || 30
      , warnGCLastData: sbx.extendedSettings.warnGCLastData || 15
      , urgentGCLastData: sbx.extendedSettings.urgentGCLastData || 30
      , stateNotifyIntrvl: sbx.extendedSettings.stateNotifyIntrvl || 0.5
      , warnGCCalibrationTime: sbx.extendedSettings.warnGCCalibrationTime || 3
      , urgentGCCalibrationTime: sbx.extendedSettings.urgentGCCalibrationTime || 1
      , warnGCDurationTime: sbx.extendedSettings.warnGCDurationTime || 24
      , urgentGCDurationTime: sbx.extendedSettings.urgentGCDurationTime || 48
    };

    if (firstPrefs) {
      firstPrefs = false;
      console.info('GuardianCOnnect Prefs:', prefs);
    }

    return prefs;
  };

  guardianconnect.setProperties = function setProperties (sbx) {
    sbx.offerProperty('guardianconnect', function setProp () {
      return guardianconnect.getStateString(sbx);
    });
  };

  guardianconnect.checkNotifications = function checkNotifications (sbx) {

    var info = sbx.properties.guardianconnect;

    if (info && info.notification) {
      var notification = _.extend({}, info.notification, {
        plugin: guardianconnect
        , debug: {
          stateString: info.lastStateString
        }
      });

      sbx.notifications.requestNotify(notification);
    }

  };

  guardianconnect.getStateString = function findLatestState (sbx) {
    var prefs = guardianconnect.getPrefs(sbx);
    var recentHours = 24;
    var recentMills = sbx.time - times.hours(recentHours).msecs;
    var result = {
      seenDevices: {}
      , sensorDurationHours: null
      , timeToNextCalibHours: null
      , lastStateTime: null
      , medicalDeviceFamily: null
      , medicalDeviceBatteryLevelPercent: null
      , batteryStatusClass: null
      , lastDataClass: null
    };

    function toMoments (status) {
      return {
        when: moment(status.mills)
        , timestamp: status.connect && status.mills && moment(status.mills)
      };
    }

    function getDevice (status) {

      var uri = status.device || 'device';
      var device = result.seenDevices[uri];

      if (!device) {
        device = {
          name: utils.deviceName(uri)
          , uri: uri
        };

        result.seenDevices[uri] = device;
      }
      return device;
    }

    var recentData = _.chain(sbx.data.devicestatus)
      .filter(function(status) {
        return ('connect' in status) && sbx.entryMills(status) <= sbx.time && sbx.entryMills(status) >= recentMills;
      })
      .value();

    recentData = _.sortBy(recentData, 'mills');
    _.forEach(recentData, function eachStatus (status) {
      getDevice(status);
      var moments = toMoments(status);
      if (status.connect && (!result.latest || moments.timestamp && moments.timestamp.isAfter(result.lastStateTime))) {
        result.latest = status;
        result.lastStateTime = moment(status.mills);
      }
    });

    var sendNotification = false;
    var sound = 'incoming';
    var message;
    var title;
    var sensorInfo = result.latest;

    result.level = levels.NONE;
    if (sensorInfo && sensorInfo.connect) {

      if (sensorInfo.connect.sensorState != "NORMAL") {
        // Send warning notification for all states that are not 'OK'
        // but only send state notifications at interval preference
        if (!lastStateNotification || (lastStateNotification.state != sensorInfo.connect.state) || !prefs.stateNotifyIntrvl || (moment().diff(lastStateNotification.timestamp, 'minutes') > (prefs.stateNotifyIntrvl * 60))) {
          sendNotification = true;
          lastStateNotification = {
            timestamp: moment()
            , state: sensorInfo.connect.sensorState
          };
        }

        message = 'CGM Transmitter state: ' + sensorInfo.connect.sensorState;
        title = 'CGM Transmitter state: ' + sensorInfo.connect.sensorState;

        result.level = levels.URGENT;

      }

      if (sensorInfo.connect.medicalDeviceBatteryLevelPercent && (sensorInfo.connect.medicalDeviceBatteryLevelPercent <= prefs.warnGCBat) && (sensorInfo.connect.medicalDeviceBatteryLevelPercent > prefs.urgentGCBat)) {
        sendNotification = true;
        message = 'CGM Transmitter Battery Low Voltage: ' + sensorInfo.connect.medicalDeviceBatteryLevelPercent;
        title = 'CGM Transmitter Battery Low';
        result.level = levels.WARN;
        result.batteryStatusClass = 'warnBackground';
      } else if (sensorInfo.connect.medicalDeviceBatteryLevelPercent && (sensorInfo.connect.medicalDeviceBatteryLevelPercent < prefs.urgentGCBat) && (sensorInfo.connect.medicalDeviceBatteryLevelPercent < prefs.warnGCBat)) {
        sendNotification = true;
        message = 'CGM Transmitter Battery Low Voltage: ' + sensorInfo.connect.medicalDeviceBatteryLevelPercent;
        title = 'CGM Transmitter Battery Low';
        result.level = levels.URGENT;
        result.batteryStatusClass = 'urgentBackground';
      } else {
        result.batteryStatusClass = '';
      }
      if (sensorInfo.connect.timeToNextCalibHours && (sensorInfo.connect.timeToNextCalibHours < prefs.warnGCCalibrationTime) && (sensorInfo.connect.timeToNextCalibHours > prefs.urgentGCCalibrationTime)) {
        sendNotification = true;
        message = 'CGM Transmitter next calibration within: ' + sensorInfo.connect.timeToNextCalibHours + 'h';
        title = 'CGM Transmitter Calibration ALARM';
        result.level = levels.WARN;
        result.calibrationTimeStatusClass = 'warnBackground';
      } else if (sensorInfo.connect.timeToNextCalibHours && (sensorInfo.connect.timeToNextCalibHours < prefs.warnGCCalibrationTime) && (sensorInfo.connect.timeToNextCalibHours < prefs.warnGCCalibrationTime)) {
        sendNotification = true;
        message = 'CGM Transmitter next calibration within: ' + sensorInfo.connect.timeToNextCalibHours + 'h';
        title = 'CGM Transmitter Calibration ALARM';
        result.level = levels.URGENT;
        result.calibrationTimeStatusClass = 'urgentBackground';
      } else {
        result.calibrationTimeStatusClass = '';
      }
      if ((moment().diff(sensorInfo.mills, 'minutes') > prefs.warnGCLastData) && (moment().diff(sensorInfo.mills, 'minutes') < prefs.urgentGCLastData)) {
        result.level = levels.WARN;
        result.lastDataClass = 'warnBackground';
      } else if (moment().diff(sensorInfo.mills, 'minutes') >= prefs.urgentGCLastData) {
        result.level = levels.URGENT;
        result.lastDataClass = 'urgentBackground';
      } else {
        result.lastDataClass = '';
      }

      if ((sensorInfo.connect.sensorDurationHours > prefs.warnGCDurationTime) && (sensorInfo.connect.sensorDurationHours < prefs.urgentGCDurationTime)) {
        result.level = levels.WARN;
        result.durationTimeStatusClass = 'warnBackground';
      } else if (sensorInfo.connect.sensorDurationHours >= prefs.urgentGCDurationTime) {
        result.level = levels.URGENT;
        result.durationTimeStatusClass = 'urgentBackground';
      } else {
        result.durationTimeStatusClass = '';
      }

      if (sensorInfo.connect.medicalDeviceBatteryLevelPercent >= 95) {
        result.batteryLevel = 100;
      } else if (sensorInfo.connect.medicalDeviceBatteryLevelPercent < 95 && sensorInfo.connect.medicalDeviceBatteryLevelPercent > 50) {
        result.batteryLevel = 75;
      } else if (sensorInfo.connect.medicalDeviceBatteryLevelPercent <= 50 && sensorInfo.connect.medicalDeviceBatteryLevelPercent >= 30) {
        result.batteryLevel = 50;
      } else {
        result.batteryLevel = 25;
      }

      if (prefs.enableAlerts && sendNotification) {
        result.notification = {
          title: title
          , message: message
          , pushoverSound: sound
          , level: result.level
          , group: 'guardianconnect'
        };
      }

      result.lastState = sensorInfo.connect.sensorState;
      result.sensorDurationHours = sensorInfo.connect.sensorDurationHours;
      result.timeToNextCalibHours = sensorInfo.connect.timeToNextCalibHours;
      result.medicalDeviceFamily = sensorInfo.connect.medicalDeviceFamily;
      result.medicalDeviceBatteryLevelPercent = sensorInfo.connect.medicalDeviceBatteryLevelPercent;
    }

    return result;

  }

  guardianconnect.updateVisualisation = function updateVisualisation (sbx) {

    var sensor = sbx.properties.guardianconnect;
    var info = [];
    //var sensorStats[{
    //SENSOR_CALIBRATION_PENDING : "Calibrate now"
    //SENSOR_FAILED: "Change sensor"
    //SENSOR_WARM_UP: Warm up... Inicjalizacja...
    //SENSOR_CALIBRATION_REQUIRED Calibrate now  Skalibruj teraz
    //SENSOR_CALIBRATION_PENDING Kalibracja
    //}]

    if (sensor) {
      info.push({ label: 'Guardian Connect', value: '', class: 'black-text' });
      info.push({
        label: translate('Last data') + ': '
        , value: (sensor && sensor.lastStateTime && moment().diff(sensor.lastStateTime, 'minutes') + ' ' + translate('mins ago')) || 'Unknown'
        , class: 'black-text ' + sensor.lastDataClass
      });
      info.push({
        label: translate('Status') + ': '
        , value: (sensor && sensor.lastState) ? translate(sensor.lastState) : translate('Unknown')
        , class: 'black-text'
      });

      info.push({
        label: translate('Next calibration') + ": "
        , value: (sensor.timeToNextCalibHours < 254) ? (sensor && sensor.timeToNextCalibHours) + 'h' : ''
        , class: 'black-text ' + sensor.calibrationTimeStatusClass
      });

      var sensonDurationDays = Math.floor(sensor.sensorDurationHours / 24) + 'd ' + (sensor.sensorDurationHours % 24) + 'h ';
      info.push({
        label: translate('Sensor end time') + ": "
        , value: (sensor.sensorDurationHours < 254) ? sensonDurationDays : ''
        , class: 'black-text ' + sensor.durationTimeStatusClass
      });

      info.push({
        label: translate('Transmitter battery') + ': '
        , value: sensor.medicalDeviceBatteryLevelPercent + '%'
        , class: 'black-text ' + sensor.batteryStatusClass
      });

      var statusClass = null;
      if (sensor.level === levels.URGENT) {
        statusClass = 'urgent';
      } else if (sensor.level === levels.WARN) {
        statusClass = 'warn';
      } else if (sensor.level === levels.INFO) {
        // Still highlight even the 'INFO' events for now 
        //statusClass = 'warn';
      }

      sbx.pluginBase.updatePillText(guardianconnect, {
        value: (sensor && sensor.lastState) ? translate(sensor.lastState) : translate('Unknown')
        , label: 'GC '
        , labelClass: 'icon-battery-' + sensor.batteryLevel + '-270deg right'
        , info: info
        , pillClass: statusClass
      });
    }
  };

  return guardianconnect;
}
module.exports = init;
