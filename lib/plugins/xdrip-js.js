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
    , pluginType: 'pill-minor'
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
    var result = {
      seenDevices: { }
      , lastDevice: null
      , lastState: null
      , lastStateString: null
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

    var recentData = _.sortBy(recentData, 'timestamp');

    _.forEach(recentData, function eachStatus (status) {
      var device = getDevice(status);

      var moments = toMoments(status);

      if (status.sensor && (!result.latest || moments.timestamp && moments.timestamp.isAfter(result.latest.timestamp))) {
        result.latest = status;
      }
    }

    var sendNotification = false;
    var sound = 'incoming';
    var message;

    var sensorInfo = result.latest;

    sensorInfo.level = levels.NONE;

    if (sensorInfo.sensor.state != 0x6) {
      sendNotification = sensorInfo.age === prefs.warn;
      message = 'Sensor state: ' + sensorInfo.sensor.stateString;
      sensorInfo.level = levels.WARN;
    }

    //allow for 20 minute period after a full hour during which we'll alert the user
    if (prefs.enableAlerts && sendNotification) {
      sensorInfo.notification = {
        title: 'Sensor State: ' + sensorInfo.stateString
        , message: message
        , pushoverSound: sound
        , level: sensorInfo.level
        , group: 'xDrip-js'
      };
    }

    result.lastState = sensorInfo.sensor.state;
    result.lastStateString = sensorInfo.sensor.stateString;
    result.lastStateTime = moment(sensorInfo.sensor.timestamp);

    return result;
  };

  sensorState.updateVisualisation = function updateVisualisation (sbx) {

    var latest = sbx.properties.sensorState;
    var sensorInfo = latest.latest
    var info = [];

    latest.seenDevices.forEach( function eachDevice(device) {
      info.push( { label: 'Seen: ', value: device.name } );
    }

    var statusClass = null;
    if (sensorInfo.level === levels.URGENT) {
      statusClass = 'urgent';
    } else if (sensorInfo.level === levels.WARN) {
      statusClass = 'warn';
    }

    sbx.pluginBase.updatePillText(sensorState, {
      value: sensorInfo.stateString
      , label: translate('xDrip-js')
      , info: info
      , pillClass: statusClass
    });
  };

  return sensorState;
}

module.exports = init;

