'use strict';

var _ = require('lodash');
var moment = require('moment');
var times = require('../times');
var levels = require('../levels');

function init(ctx) {
  var utils = require('../utils')(ctx);

  var sensorState = {
    name: 'xdrip-js'
    , label: 'Sensor Status'
    , pluginType: 'pill-status'
  };

  sensorState.getPrefs = function getPrefs(sbx) {
    return {
      enableAlerts: sbx.extendedSettings.enableAlerts || false
    };
  };

  sensorState.setProperties = function setProperties (sbx) {
    sbx.offerProperty('sensorState', function setProp ( ) {
      return sensorState.getStateString(sbx);
    });
  };

  sensorState.checkNotifications = function checkNotifications(sbx) {

    var info = sbx.properties.sensorState;
    var sensorInfo = info.latest;

    if (sensorInfo && sensorInfo.notification) {
      var notification = _.extend({}, sensorInfo.notification, {
        plugin: sensorState
        , debug: {
          stateString: sensorInfo.stateString
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
      , lastStateTime: null
      , lastVoltageA: null
      , lastVoltageB: null
      , lastRuntime: null
      , lastTemperature: null
      , lastResistance: null
      , lastTxState: null
      , lastTxStateString: null
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

    var sensorInfo = result.latest;

    result.level = levels.NONE;

    if (sensorInfo && sensorInfo.xdripjs) {

      if (sensorInfo.xdripjs.state != 0x6) {
        // TODO: determine whether to send a notification
        sendNotification = true;
        message = 'Sensor state: ' + sensorInfo.xdripjs.stateString;
        result.level = levels.WARN;
      }

      //allow for 20 minute period after a full hour during which we'll alert the user
      if (prefs.enableAlerts && sendNotification) {
        sensorInfo.notification = {
          title: 'Sensor State: ' + sensorInfo.xdripjs.stateString
          , message: message
          , pushoverSound: sound
          , level: result.level
          , group: 'xDrip-js'
        };
      }

      result.lastState = sensorInfo.xdripjs.state;
      result.lastStateString = sensorInfo.xdripjs.stateString;
      result.lastStateStringShort = sensorInfo.xdripjs.stateStringShort;
      result.lastVoltageA = sensorInfo.xdripjs.voltagea;
      result.lastVoltageB = sensorInfo.xdripjs.voltageb;
      result.lastRuntime = sensorInfo.xdripjs.runtime;
      result.lastTemperature = sensorInfo.xdripjs.temperature;
      result.lastResistance = sensorInfo.xdripjs.resistance;
      result.lastTxState = sensorInfo.xdripjs.txState;
      result.lastTxStateString = sensorInfo.xdripjs.txStateString;
    }

    return result;
  };

  sensorState.updateVisualisation = function updateVisualisation (sbx) {

    var sensor = sbx.properties.sensorState;
    var info = [];

    _.forIn(sensor.seenDevices, function seenDevice (device) {
      info.push( { label: 'Seen: ', value: device.name } );
    });

    info.push( { label: 'Status: ', value: (sensor && sensor.lastStateString) || 'Unknown' } );
    info.push( { label: 'State Time: ', value: (sensor && sensor.lastStateTime && sensor.lastStateTime.format()) || 'Unknown' } );

    if (sensor && sensor.lastVoltageA) {
      info.push( { label: 'VoltageA: ', value: sensor.lastVoltageA } );
    }

    if (sensor && sensor.lastVoltageB) {
      info.push( { label: 'VoltageB: ', value: sensor.lastVoltageB } );
    }

    if (sensor && sensor.lastRuntime) {
      info.push( { label: 'Runtime: ', value: sensor.lastRunTime } );
    }

    if (sensor && sensor.lastTemperature) {
      info.push( { label: 'Temperature: ', value: sensor.lastTemperature } );
    }

    if (sensor && sensor.lastResistance) {
      info.push( { label: 'Resistance: ', value: sensor.lastResistance } );
    }

    if (sensor && sensor.lastTxStateString) {
      info.push( { label: 'Txmitter State: ', value: sensor.lastTxStateString } );
    }

    if (sensor) {
      var statusClass = null;
      if (sensor.level === levels.URGENT) {
          statusClass = 'urgent';
      } else if (sensor.level === levels.WARN) {
        statusClass = 'warn';
      }

      sbx.pluginBase.updatePillText(sensorState, {
        value: (sensorInfo && sensorInfo.xdripjs.stateStringShort) || (sensorInfo && sensorInfo.xdripjs.stateString) || 'Unknown'
        , label: 'CGM'
        , info: info
        , pillClass: statusClass
      });
    }
  };

  return sensorState;
}

module.exports = init;

