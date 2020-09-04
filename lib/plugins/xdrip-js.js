'use strict';

var _ = require('lodash');
var moment = require('moment');
var times = require('../times');
var levels = require('../levels');

function init(ctx) {
  var utils = require('../utils')(ctx);
  var firstPrefs = true;
  var lastStateNotification = null;

  var sensorState = {
    name: 'xdrip-js'
    , label: 'CGM Status'
    , pluginType: 'pill-status'
  };

  sensorState.getPrefs = function getPrefs(sbx) {
    var prefs = {
      enableAlerts: sbx.extendedSettings.enableAlerts || false
      , warnBatV: sbx.extendedSettings.warnBatV || 300
      , stateNotifyIntrvl: sbx.extendedSettings.stateNotifyIntrvl || 0.5
    };

    if (firstPrefs) {
      firstPrefs = false;
      console.info('xdrip-js Prefs:', prefs);
    }

    return prefs;
  };

  sensorState.setProperties = function setProperties (sbx) {
    sbx.offerProperty('sensorState', function setProp ( ) {
      return sensorState.getStateString(sbx);
    });
  };

  sensorState.checkNotifications = function checkNotifications(sbx) {

    var info = sbx.properties.sensorState;

    if (info && info.notification) {
      var notification = _.extend({}, info.notification, {
        plugin: sensorState
        , debug: {
          stateString: info.lastStateString
        }
      });

      sbx.notifications.requestNotify(notification);
    }

  };

  sensorState.getStateString = function findLatestState(sbx) {
    var prefs = sensorState.getPrefs(sbx);

    var recentHours = 24; 
    var recentMills = sbx.time - times.hours(recentHours).msecs;

    var result = {
      seenDevices: { }
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
      return {
        when:  moment(status.mills)
        , timestamp: status.xdripjs && status.xdripjs.timestamp && moment(status.xdripjs.timestamp)
      };
    }

    function getDevice(status) {
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
      .filter(function (status) {
        return ('xdripjs' in status) && sbx.entryMills(status) <= sbx.time && sbx.entryMills(status) >= recentMills;
      })
      .value( );

    recentData = _.sortBy(recentData, 'xdripjs.timestamp');

    _.forEach(recentData, function eachStatus (status) {
      getDevice(status);

      var moments = toMoments(status);

      if (status.xdripjs && (!result.latest || moments.timestamp && moments.timestamp.isAfter(result.lastStateTime))) {
        result.latest = status;
        result.lastStateTime = moment(status.xdripjs.timestamp);
      }
    });

    var sendNotification = false;
    var sound = 'incoming';
    var message;
    var title;

    var sensorInfo = result.latest;

    result.level = levels.NONE;

    if (sensorInfo && sensorInfo.xdripjs) {

      if (sensorInfo.xdripjs.state != 0x6) {
        // Send warning notification for all states that are not 'OK'
        // but only send state notifications at interval preference
        if (!lastStateNotification || (lastStateNotification.state != sensorInfo.xdripjs.state) || !prefs.stateNotifyIntrvl || (moment().diff(lastStateNotification.timestamp, 'minutes') > (prefs.stateNotifyIntrvl*60))) {
          sendNotification = true;
          lastStateNotification = {
            timestamp: moment()
            , state: sensorInfo.xdripjs.state
          };
        }

        message = 'CGM state: ' + sensorInfo.xdripjs.stateString;
        title = 'CGM state: ' + sensorInfo.xdripjs.stateString;

        if (sensorInfo.xdripjs.state == 0x7) {
          // If it is a calibration request, only use INFO
          result.level = levels.INFO;
        } else {
          result.level = levels.WARN;
        }
      }

      if (sensorInfo.xdripjs.voltagea && (sensorInfo.xdripjs.voltagea < prefs.warnBatV)) {
        sendNotification = true;
        message = 'CGM Battery A Low Voltage: ' + sensorInfo.xdripjs.voltagea;
        title = 'CGM Battery Low';
        result.level = levels.WARN;
      }

      if (sensorInfo.xdripjs.voltageb && (sensorInfo.xdripjs.voltageb < prefs.warnBatV)) {
        sendNotification = true;
        message = 'CGM Battery B Low Voltage: ' + sensorInfo.xdripjs.voltageb;
        title = 'CGM Battery Low';
        result.level = levels.WARN;
      }

      if (prefs.enableAlerts && sendNotification) {
        result.notification = {
          title: title
          , message: message
          , pushoverSound: sound
          , level: result.level
          , group: 'xDrip-js'
        };
      }

      result.lastState = sensorInfo.xdripjs.state;
      result.lastStateString = sensorInfo.xdripjs.stateString;
      result.lastStateStringShort = sensorInfo.xdripjs.stateStringShort;
      result.lastSessionStart = sensorInfo.xdripjs.sessionStart;
      result.lastTxId = sensorInfo.xdripjs.txId;
      result.lastTxStatus = sensorInfo.xdripjs.txStatus;
      result.lastTxStatusString = sensorInfo.xdripjs.txStatusString;
      result.lastTxStatusStringShort = sensorInfo.xdripjs.txStatusStringShort;
      result.lastTxActivation = sensorInfo.xdripjs.txActivation;
      result.lastMode = sensorInfo.xdripjs.mode;
      result.lastRssi = sensorInfo.xdripjs.rssi;
      result.lastUnfiltered = sensorInfo.xdripjs.unfiltered;
      result.lastFiltered = sensorInfo.xdripjs.filtered;
      result.lastNoise = sensorInfo.xdripjs.noise;
      result.lastNoiseString = sensorInfo.xdripjs.noiseString;
      result.lastSlope = Math.round(sensorInfo.xdripjs.slope * 100) / 100.0;
      result.lastIntercept = Math.round(sensorInfo.xdripjs.intercept * 100) / 100.0;
      result.lastCalType = sensorInfo.xdripjs.calType;
      result.lastCalibrationDate = sensorInfo.xdripjs.lastCalibrationDate;
      result.lastBatteryTimestamp = sensorInfo.xdripjs.batteryTimestamp;
      result.lastVoltageA = sensorInfo.xdripjs.voltagea;
      result.lastVoltageB = sensorInfo.xdripjs.voltageb;
      result.lastTemperature = sensorInfo.xdripjs.temperature;
      result.lastResistance = sensorInfo.xdripjs.resistance;
    }

    return result;
  };

  sensorState.updateVisualisation = function updateVisualisation (sbx) {

    var sensor = sbx.properties.sensorState;
    var sessionDuration = 'Unknown';
    var info = [];

    _.forIn(sensor.seenDevices, function seenDevice (device) {
      info.push( { label: 'Seen: ', value: device.name } );
    });

    info.push( { label: 'State Time: ', value: (sensor && sensor.lastStateTime && moment().diff(sensor.lastStateTime, 'minutes') + ' minutes ago') || 'Unknown' } );
    info.push( { label: 'Mode: ', value: (sensor && sensor.lastMode) || 'Unknown' } );
    info.push( { label: 'Status: ', value: (sensor && sensor.lastStateString) || 'Unknown' } );

    // session start is only valid if in a session
    if (sensor && sensor.lastSessionStart && (sensor.lastState != 0x1)) {
      var diffTime = moment().diff(moment(sensor.lastSessionStart));
      var duration = moment.duration(diffTime);

      sessionDuration = duration.days() + ' days ' + duration.hours() + ' hours';

      info.push( { label: 'Session Age: ', value: sessionDuration } );
    }

    info.push( { label: 'Tx ID: ', value: (sensor && sensor.lastTxId) || 'Unknown' } );
    info.push( { label: 'Tx Status: ', value: (sensor && sensor.lastTxStatusString) || 'Unknown' } );

    if (sensor) {
      if (sensor.lastTxActivation) {
        info.push( { label: 'Tx Age: ', value: moment().diff(moment(sensor.lastTxActivation), 'days') + ' days' } );
      }

      if (sensor.lastRssi) {
        info.push( { label: 'RSSI: ', value: sensor.lastRssi } );
      }

      if (sensor.lastUnfiltered) {
        info.push( { label: 'Unfiltered: ', value: sensor.lastUnfiltered } );
      }

      if (sensor.lastFiltered) {
        info.push( { label: 'Filtered: ', value: sensor.lastFiltered } );
      }

      if (sensor.lastNoiseString) {
        info.push( { label: 'Noise: ', value: sensor.lastNoiseString } );
      }

      if (sensor.lastSlope) {
        info.push( { label: 'Slope: ', value: sensor.lastSlope } );
      }

      if (sensor.lastIntercept) {
        info.push( { label: 'Intercept: ', value: sensor.lastIntercept } );
      }

      if (sensor.lastCalType) {
        info.push( { label: 'CalType: ', value: sensor.lastCalType } );
      }

      if (sensor.lastCalibrationDate) {
        info.push( { label: 'Calibration: ', value: moment().diff(moment(sensor.lastCalibrationDate), 'hours') + ' hours ago' } );
      }

      if (sensor.lastBatteryTimestamp) {
        info.push( { label: 'Battery: ', value: moment().diff(moment(sensor.lastBatteryTimestamp), 'minutes') + ' minutes ago' } );
      }

      if (sensor.lastVoltageA) {
        info.push( { label: 'VoltageA: ', value: sensor.lastVoltageA } );
      }

      if (sensor.lastVoltageB) {
        info.push( { label: 'VoltageB: ', value: sensor.lastVoltageB } );
      }

      if (sensor.lastTemperature) {
        info.push( { label: 'Temperature: ', value: sensor.lastTemperature } );
      }

      if (sensor.lastResistance) {
        info.push( { label: 'Resistance: ', value: sensor.lastResistance } );
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

      sbx.pluginBase.updatePillText(sensorState, {
        value: (sensor && sensor.lastStateStringShort) || (sensor && sensor.lastStateString) || 'Unknown'
        , label: 'CGM'
        , info: info
        , pillClass: statusClass
      });
    }
  };

  return sensorState;
}

module.exports = init;

