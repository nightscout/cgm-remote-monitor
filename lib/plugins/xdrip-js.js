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

    if (sensorInfo.notification) {
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
    };

    function toMoments (status) {
      return {
        when:  moment(status.mills)
        , timestamp: status.sensor && status.sensor.timestamp && moment(status.sensor.timestamp)
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
        return ('sensor' in status) && sbx.entryMills(status) <= sbx.time && sbx.entryMills(status) >= recentMills;
      })
      .value( );

    recentData = _.sortBy(recentData, 'sensor.timestamp');

    _.forEach(recentData, function eachStatus (status) {
      var device = getDevice(status);

      var moments = toMoments(status);

      if (status.sensor && (!result.latest || moments.timestamp && moments.timestamp.isAfter(result.latest.timestamp))) {
        result.latest = status;
        result.latest.timestamp = moment(status.sensor.timestamp);
      }
    });

    var sendNotification = false;
    var sound = 'incoming';
    var message;

    var sensorInfo = result.latest;

    if (sensorInfo) {
      sensorInfo.level = levels.NONE;

      if (sensorInfo.sensor.state != 0x6) {
        // TODO: determine whether to send a notification
        sendNotification = true;
        message = 'Sensor state: ' + sensorInfo.sensor.stateString;
        sensorInfo.level = levels.WARN;
      }

      //allow for 20 minute period after a full hour during which we'll alert the user
      if (prefs.enableAlerts && sendNotification) {
        sensorInfo.notification = {
          title: 'Sensor State: ' + sensorInfo.sensor.stateString
          , message: message
          , pushoverSound: sound
          , level: sensorInfo.level
          , group: 'xDrip-js'
        };
      }

      result.lastState = sensorInfo.sensor.state;
      result.lastStateString = sensorInfo.sensor.stateString;
      result.lastStateStringShort = sensorInfo.sensor.stateStringShort;
      result.lastStateTime = moment(sensorInfo.sensor.timestamp);
    }

    return result;
  };

  sensorState.updateVisualisation = function updateVisualisation (sbx) {

    var latest = sbx.properties.sensorState;
    var sensorInfo = latest.latest;
    var info = [];

    _.forIn(latest.seenDevices, function seenDevice (device) {
      info.push( { label: 'Seen: ', value: device.name } );
    });

    if (sensorInfo) {
      var statusClass = null;
      if (sensorInfo.level === levels.URGENT) {
        statusClass = 'urgent';
      } else if (sensorInfo.level === levels.WARN) {
        statusClass = 'warn';
      }
    }

    sbx.pluginBase.updatePillText(sensorState, {
      value: (sensorInfo && sensorInfo.sensor.stateStringShort) || (sensorInfo && sensorInfo.sensor.stateString) || 'Unknown'
      , label: 'CGM'
      , info: info
      , pillClass: statusClass
    });
  };

  return sensorState;
}

module.exports = init;

