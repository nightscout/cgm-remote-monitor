'use strict';

var _ = require('lodash');
var moment = require('moment');
var times = require('../times');
var levels = require('../levels');

function init (ctx) {
  var utils = require('../utils')(ctx);
  var firstPrefs = true;
  var lastStateNotification = null;
  //var translate = ctx.language.translate;

  var guardianconnectState = {
    name: 'guardianconnect'
    , label: 'Guardian Connect'
    , pluginType: 'pill-status'
  };

  guardianconnectState.getPrefs = function getPrefs (sbx) {
    var prefs = {
      enableAlerts: sbx.extendedSettings.enableAlerts || false
      , warnBatV: sbx.extendedSettings.warnBatV || 300
      , stateNotifyIntrvl: sbx.extendedSettings.stateNotifyIntrvl || 0.5
    };

    if (firstPrefs) {
      firstPrefs = false;
      console.info('GuardianCOnnect Prefs:', prefs);
    }

    return prefs;
  };

  guardianconnectState.setProperties = function setProperties (sbx) {
    sbx.offerProperty('guardianconnectState', function setProp () {
      return guardianconnectState.getStateString(sbx);
    });
  };

  guardianconnectState.checkNotifications = function checkNotifications (sbx) {

    var info = sbx.properties.guardianconnectState;

    if (info && info.notification) {
      var notification = _.extend({}, info.notification, {
        plugin: guardianconnectState
        , debug: {
          stateString: info.lastStateString
        }
      });

      sbx.notifications.requestNotify(notification);
    }

  };

  guardianconnectState.getStateString = function findLatestState (sbx) {
    //console.warn("DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD");
    //console.warn(sbx);
    var prefs = guardianconnectState.getPrefs(sbx);
    //console.warn("EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE");
    //console.warn(prefs);
    var recentHours = 24;
    var recentMills = sbx.time - times.hours(recentHours).msecs;
    //console.warn("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
    //console.warn(recentMills);
    var result = {
      seenDevices: {}
      , latest: null
      , lastDevice: null
      , lastState: null
      , lastStateString: null
      , lastStateStringShort: null
      , lastSessionStart: null
      , lastStateTime: null
      , lastTxId: null
      , lastTxStatus: null
      , lastTxStatusString: null
      , lastTxStatusStringShort: null
      , lastTxActivation: null
      , lastMode: null
      , lastRssi: null
      , lastUnfiltered: null
      , lastFiltered: null
      , lastNoise: null
      , lastNoiseString: null
      , lastSlope: null
      , lastIntercept: null
      , lastCalType: null
      , lastCalibrationDate: null
      , lastBatteryTimestamp: null
      , lastVoltageA: null
      , lastVoltageB: null
      , lastTemperature: null
      , lastResistance: null
    };

    function toMoments (status) {
      //console.warn("LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL");
      //console.warn(status.connect);
      //console.warn("LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL");
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
      //console.warn("JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ");
      //console.warn(moments);
      //console.warn("JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ");

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
    //console.warn("KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK");
    //console.warn(result);
    //console.warn("KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK");
    //console.warn("MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM");
    //console.warn(sensorInfo);
    //console.warn("MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM");
    if (sensorInfo && sensorInfo.connect) {

      if (sensorInfo.connect.sensorState != "NORMAL") {
        // Send warning notification for all states that are not 'OK'
        // but only send state notifications at interval preference
        if (!lastStateNotification || (lastStateNotification.state != sensorInfo.connect.state) || !prefs.stateNotifyIntrvl || (moment().diff(lastStateNotification.timestamp, 'minutes') > (prefs.stateNotifyIntrvl * 60))) {
          sendNotification = true;
          lastStateNotification = {
            timestamp: moment()
            , state: sensorInfo.connect.state
          };
        }

        message = 'CGM Transmitter state: ' + sensorInfo.sensorInfo.connect.state;
        title = 'CGM Transmitter state: ' + sensorInfo.connect.state;

        if (sensorInfo.connect.state == 0x7) {
          // If it is a calibration request, only use INFO
          result.level = levels.INFO;
        } else {
          result.level = levels.WARN;
        }
      }

      if (sensorInfo.connect.medicalDeviceBatteryLevelPercent && (sensorInfo.connect.medicalDeviceBatteryLevelPercent < prefs.warnBatV)) {
        sendNotification = true;
        message = 'CGM Transmitter Battery Low Voltage: ' + sensorInfo.connect.medicalDeviceBatteryLevelPercent;
        title = 'CGM Transmitter Battery Low';
        result.level = levels.WARN;
      }

      /*if (sensorInfo.guardianconnect.voltageb && (sensorInfo.guardianconnect.voltageb < (prefs.warnBatV - 10))) {
        sendNotification = true;
        message = 'CGM Transmitter Battery B Low Voltage: ' + sensorInfo.guardianconnect.voltageb;
        title = 'CGM Transmitter Battery Low';
        result.level = levels.WARN;
      }
      */

      if (prefs.enableAlerts && sendNotification) {
        result.notification = {
          title: title
          , message: message
          , pushoverSound: sound
          , level: result.level
          , group: 'guardianconnect'
        };
      }
      //console.warn("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
      //console.warn(sensorInfo);
      //console.warn("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
      result.lastState = sensorInfo.connect.sensorState;
      result.sensorDurationHours = sensorInfo.connect.sensorDurationHours;
      result.timeToNextCalibHours = sensorInfo.connect.timeToNextCalibHours;
      result.medicalDeviceBatteryLevelPercent = sensorInfo.connect.medicalDeviceBatteryLevelPercent;
      result.lastUnfiltered = sensorInfo.connect.unfiltered;
      result.lastFiltered = sensorInfo.connect.filtered;
      result.lastNoise = sensorInfo.connect.noise;
      result.lastNoiseString = sensorInfo.connect.noiseString;
      result.lastSlope = Math.round(sensorInfo.connect.slope * 100) / 100.0;
      result.lastIntercept = Math.round(sensorInfo.connect.intercept * 100) / 100.0;
      result.lastCalType = sensorInfo.connect.calType;
      result.lastCalibrationDate = sensorInfo.connect.lastCalibrationDate;
      result.lastBatteryTimestamp = sensorInfo.connect.batteryTimestamp;
      result.lastVoltageA = sensorInfo.connect.voltagea;
      result.lastVoltageB = sensorInfo.connect.voltageb;
      result.lastTemperature = sensorInfo.connect.temperature;
      result.lastResistance = sensorInfo.connect.resistance;
    }

    return result;

  }

  guardianconnectState.updateVisualisation = function updateVisualisation (sbx) {

    var sensor = sbx.properties.guardianconnectState;
    var sessionDuration = 'Unknown';
    var info = [];

    _.forIn(sensor.seenDevices, function seenDevice (device) {

      console.warn("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
      console.warn(sensor);
      console.warn("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
      info.push({ label: 'DEVICE: ', value: device.name });
    });

    info.push({ label: 'State Time: ', value: (sensor && sensor.lastStateTime && moment().diff(sensor.lastStateTime, 'minutes') + ' minutes ago') || 'Unknown' });
    info.push({ label: 'Status: ', value: (sensor && sensor.lastState) || 'Unknown' });
    // session start is only valid if in a session
    if (sensor && sensor.lastSessionStart && (sensor.lastState != 0x1)) {
      var diffTime = moment().diff(moment(sensor.lastSessionStart));
      var duration = moment.duration(diffTime);

      sessionDuration = duration.days() + ' days ' + duration.hours() + ' hours';

      info.push({ label: 'Session Age: ', value: sessionDuration });
    }

    info.push({ label: 'Sensor duration: ', value: (sensor && sensor.sensorDurationHours) || 'Unknown' });
    info.push({ label: 'Calibration needed: ', value: (sensor && sensor.timeToNextCalibHours) || 'Unknown' });

    if (sensor) {
      if (sensor.lastTxActivation) {
        info.push({ label: 'Tx Age: ', value: moment().diff(moment(sensor.lastTxActivation), 'days') + ' days' });
      }

      if (sensor.lastRssi) {
        info.push({ label: 'RSSI: ', value: sensor.lastRssi });
      }

      if (sensor.lastUnfiltered) {
        info.push({ label: 'Unfiltered: ', value: sensor.lastUnfiltered });
      }

      if (sensor.lastFiltered) {
        info.push({ label: 'Filtered: ', value: sensor.lastFiltered });
      }

      if (sensor.lastNoiseString) {
        info.push({ label: 'Noise: ', value: sensor.lastNoiseString });
      }

      if (sensor.lastSlope) {
        info.push({ label: 'Slope: ', value: sensor.lastSlope });
      }

      if (sensor.lastIntercept) {
        info.push({ label: 'Intercept: ', value: sensor.lastIntercept });
      }

      if (sensor.lastCalType) {
        info.push({ label: 'CalType: ', value: sensor.lastCalType });
      }

      if (sensor.lastCalibrationDate) {
        info.push({ label: 'Calibration: ', value: moment().diff(moment(sensor.lastCalibrationDate), 'hours') + ' hours ago' });
      }

      if (sensor.lastBatteryTimestamp) {
        info.push({ label: 'Battery: ', value: moment().diff(moment(sensor.lastBatteryTimestamp), 'minutes') + ' minutes ago' });
      }

      if (sensor.lastVoltageA) {
        info.push({ label: 'VoltageA: ', value: sensor.lastVoltageA });
      }

      if (sensor.lastVoltageB) {
        info.push({ label: 'VoltageB: ', value: sensor.lastVoltageB });
      }

      if (sensor.lastTemperature) {
        info.push({ label: 'Temperature: ', value: sensor.lastTemperature });
      }

      if (sensor.lastResistance) {
        info.push({ label: 'Resistance: ', value: sensor.lastResistance });
      }

      var statusClass = null;
      if (sensor.level === levels.URGENT) {
        statusClass = 'urgent';
      } else if (sensor.level === levels.WARN) {
        statusClass = 'warn';
      } else if (sensor.level === levels.INFO) {
        // Still highlight even the 'INFO' events for now
        statusClass = 'warn';
      }

      sbx.pluginBase.updatePillText(guardianconnectState, {
        value: (sensor && sensor.lastState) || (sensor && sensor.lastState) || 'Unknown'
        , label: 'GC'
        , info: info
        , pillClass: statusClass
      });
    }
  };

  console.warn(guardianconnectState);

  return guardianconnectState;
}
console.warn("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
module.exports = init;
