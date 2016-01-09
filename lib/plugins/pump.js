'use strict';

var _ = require('lodash');
var moment = require('moment');
var times = require('../times');
var levels = require('../levels');
var timeago = require('./timeago')();

function init() {

  var pump = {
    name: 'pump'
    , label: 'Pump'
    , pluginType: 'pill-status'
  };

  pump.getPrefs = function getPrefs(sbx) {
    return {
      warnR: sbx.extendedSettings.warnR ? sbx.extendedSettings.warnR : 10,
      urgentR: sbx.extendedSettings.urgentR ? sbx.extendedSettings.urgentR : 5,
      warnV: sbx.extendedSettings.warnV ? sbx.extendedSettings.warnV : 1.35,
      urgentV: sbx.extendedSettings.urgentV ? sbx.extendedSettings.urgentV : 1.3,
      enableAlerts: sbx.extendedSettings.enableAlerts
    };
  };

  pump.setProperties = function setProperties (sbx) {
    sbx.offerProperty('pump', function setPump ( ) {
      var pumpStatus = _.findLast(sbx.data.devicestatus, function (status) {
        return sbx.entryMills(status) <= sbx.time && ('pump' in status);
      });

      pumpStatus = pumpStatus || {};
      pumpStatus.status = checkStatus(pumpStatus, pump.getPrefs(sbx));

      return pumpStatus;
    });
  };

  pump.checkNotifications = function checkNotifications(sbx) {
    var prefs = pump.getPrefs(sbx);

    if (!prefs.enableAlerts) { return; }

    var status = checkStatus(sbx.properties.pump, prefs);

    if (status.level >= levels.WARN) {
      sbx.notifications.requestNotify({
        level: status.level
        , title: status.title
        , message: status.message
        , pushoverSound: 'echo'
        , plugin: pump
      });
    }
  };

  pump.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.pump;

    var prefs = pump.getPrefs(sbx);
    var status = checkStatus(prop, prefs);

    var values = [ ];

    if (status.reservoir) {
      values.push(status.reservoir + 'U');
    }

    if (status.batteryPercent) {
      values.push(status.batteryPercent + '%');
    } else if (status.voltage) {
      values.push(status.voltage + 'v');
    }

    sbx.pluginBase.updatePillText(pump, {
      value: values.join(' ')
      , label: 'Pump'
      , pillClass: statusClass(status.level)
    });
  };

  return pump;

}

function statusClass (level) {
  var cls = 'current';

  if (level === levels.WARN) {
    cls = 'warn';
  } else if (level === levels.URGENT) {
    cls = 'urgent';
  }

  return cls;
}

function checkStatus (prop, prefs) {
  var reservoir = prop && prop.pump && prop.pump.reservoir;
  var batteryPercent = prop && prop.pump && prop.pump.battery && prop.pump.battery.percent;
  var voltage = prop && prop.pump && prop.pump.battery && prop.pump.battery.voltage;

  var result = {
    level: levels.NONE
    , reservoir: reservoir
    , voltage: voltage
    , batteryPercent: batteryPercent
  };

  if (voltage < prefs.urgentV) {
    result.level = levels.URGENT;
    result.title = 'URGENT: Pump Battery Low';
  } else if (voltage < prefs.warnV) {
    result.level = levels.WARN;
    result.title = 'Warning, Pump Battery Low';
  }

  if (result.level < levels.URGENT && reservoir < prefs.urgentR) {
    result.level = levels.URGENT;
    result.title = 'URGENT: Pump Reservoir Low';
  } else if (result.level < levels.WARN && reservoir < prefs.warnR) {
    result.level = levels.WARN;
    result.title = 'Warning, Pump Reservoir Low';
  }

  if (result.level > levels.NONE) {
    var message = [];
    if (voltage) {
      message.push('Pump Battery: ' + voltage + 'v');
    }
    if (reservoir) {
      message.push('Pump Reservoir: ' + reservoir + 'U');
    }
    result.message = message.join('\n');
  }

  return result;
}

module.exports = init;