'use strict';

var _ = require('lodash');
var moment = require('moment');
var levels = require('../levels');
var timeago = require('./timeago')();
var openaps = require('./openaps')();

var ALL_STATUS_FIELDS = ['reservoir', 'battery', 'clock', 'status'];

function init ( ) {

  var pump = {
    name: 'pump'
    , label: 'Pump'
    , pluginType: 'pill-status'
  };

  pump.getPrefs = function getPrefs (sbx) {

    function cleanList (value) {
      return decodeURIComponent(value || '').toLowerCase().split(' ');
    }

    function isEmpty (list) {
      return _.isEmpty(list) || _.isEmpty(list[0]);
    }

    var fields = cleanList(sbx.extendedSettings.fields);
    fields = isEmpty(fields) ? ['reservoir'] : fields;

    var retroFields = cleanList(sbx.extendedSettings.retroFields);
    retroFields = isEmpty(retroFields) ? ['reservoir', 'battery'] : retroFields;

    return {
      fields: fields
      , retroFields: retroFields
      , warnClock: sbx.extendedSettings.warnClock || 30
      , urgentClock: sbx.extendedSettings.urgentClock || 60
      , warnRes: sbx.extendedSettings.warnRes || 10
      , urgentRes: sbx.extendedSettings.urgentRes || 5
      , warnBattV: sbx.extendedSettings.warnBattV || 1.35
      , urgentBattV: sbx.extendedSettings.urgentBattV || 1.3
      , warnBattP: sbx.extendedSettings.warnBattP || 30
      , urgentBattP: sbx.extendedSettings.urgentBattP || 20
      , enableAlerts: sbx.extendedSettings.enableAlerts || false
    };
  };

  pump.setProperties = function setProperties (sbx) {
    sbx.offerProperty('pump', function setPump ( ) {
      var pumpStatus = _.findLast(sbx.data.devicestatus, function (status) {
        return sbx.entryMills(status) <= sbx.time && ('pump' in status);
      });

      pumpStatus = pumpStatus || {};
      pumpStatus.data = prepareData(pumpStatus, pump.getPrefs(sbx), sbx);

      return pumpStatus;
    });
  };

  pump.checkNotifications = function checkNotifications (sbx) {
    var prefs = pump.getPrefs(sbx);

    if (!prefs.enableAlerts) { return; }

    var data = prepareData(sbx.properties.pump, prefs, sbx);

    if (data.level >= levels.WARN) {
      sbx.notifications.requestNotify({
        level: data.level
        , title: data.title
        , message: data.message
        , pushoverSound: 'echo'
        , plugin: pump
      });
    }
  };

  pump.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.pump;

    var prefs = pump.getPrefs(sbx);
    var result = prepareData(prop, prefs, sbx);

    var values = [ ];
    var info = [ ];

    var selectedFields = sbx.data.inRetroMode ? prefs.retroFields : prefs.fields;

    _.forEach(ALL_STATUS_FIELDS, function eachField (fieldName) {
      var field = result[fieldName];
      if (field) {
        var selected = _.indexOf(selectedFields, fieldName) > -1;
        if (selected) {
          values.push(field.display);
        } else {
          info.push({label: field.label, value: field.display});
        }
      }
    });

    sbx.pluginBase.updatePillText(pump, {
      value: values.join(' ')
      , info: info
      , label: 'Pump'
      , pillClass: statusClass(result.level)
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


function updateClock (prefs, result, sbx) {
  if (result.clock) {
    result.clock.label = 'Last Clock';
    result.clock.display = timeFormat(result.clock.value, sbx);

    var urgent = moment(sbx.time).subtract(prefs.urgentClock, 'minutes');
    var warn = moment(sbx.time).subtract(prefs.warnClock, 'minutes');

    if (urgent.isAfter(result.clock.value)) {
      result.clock.level = levels.URGENT;
      result.clock.message = 'URGENT: Pump data stale';
    } else if (warn.isAfter(result.clock.value)) {
      result.clock.level = levels.WARN;
      result.clock.message = 'Warning, Pump data stale';
    } else {
      result.clock.level = levels.NONE;
    }
  }
}

function updateReservoir (prefs, result) {
  if (result.reservoir) {
    result.reservoir.label = 'Reservoir';
    result.reservoir.display = result.reservoir.value + 'U';
    if (result.reservoir.value < prefs.urgentRes) {
      result.reservoir.level = levels.URGENT;
      result.reservoir.message = 'URGENT: Pump Reservoir Low';
    } else if (result.reservoir.value < prefs.warnRes) {
      result.reservoir.level = levels.WARN;
      result.reservoir.message = 'Warning, Pump Reservoir Low';
    } else {
      result.reservoir.level = levels.NONE;
    }
  }
}

function updateBattery (type, prefs, result) {
  if (result.battery) {
    result.battery.label = 'Battery';
    result.battery.display = result.battery.value + type;
    var urgent = type === 'v' ? prefs.urgentBattV : prefs.urgentBattP;
    var warn = type === 'v' ? prefs.warnBattV : prefs.warnBattP;

    if (result.battery.value < urgent) {
      result.battery.level = levels.URGENT;
      result.battery.message = 'URGENT: Pump Battery Low';
    } else if (result.battery.value < warn) {
      result.battery.level = levels.WARN;
      result.battery.message = 'Warning, Pump Battery Low';
    } else {
      result.battery.level = levels.NONE;
    }
  }
}


function buildMessage (result) {
  if (result.level > levels.NONE) {
    var message = [];

    if (result.battery) {
      message.push('Pump Battery: ' + result.battery.display);
    }

    if (result.reservoir) {
      message.push('Pump Reservoir: ' + result.reservoir.display);
    }

    result.message = message.join('\n');
  }
}

function updateStatus(pump, result) {
  if (pump.status) {
    var status = pump.status.status || 'normal';
    if (pump.status.bolusing) {
      status = 'bolusing';
    } else if (pump.status.suspended) {
      status = 'suspended';
    }
    result.status = { value: status, display: status, label: 'Status' };
  }
}

function prepareData (prop, prefs, sbx) {
  var pump = (prop && prop.pump) || { };

  var result = {
    level: levels.NONE
    , clock: pump.clock ? { value: moment(pump.clock) } : null
    , reservoir: pump.reservoir ? { value: pump.reservoir } : null
  };

  updateClock(prefs, result, sbx);
  updateReservoir(prefs, result);
  updateStatus(pump, result);

  if (pump.battery && pump.battery.percent) {
    result.battery = { value: pump.battery.percent };
    updateBattery('%', prefs, result);
  } else if (pump.battery && pump.battery.voltage) {
    result.battery = { value: pump.battery.voltage };
    updateBattery('v', prefs, result);
  }

  result.title = 'Pump Status';
  result.level = levels.NONE;

  //TODO: A new Pump Offline marker?  Something generic?  Use something new instead of a treatment?
  if (openaps.findOfflineMarker(sbx)) {
    console.info('OpenAPS known offline, not checking for alerts');
  } else {
    _.forEach(ALL_STATUS_FIELDS, function eachField(fieldName) {
      var field = result[fieldName];
      if (field && field.level > result.level) {
        result.level = field.level;
        result.title = field.message;
      }
    });
  }

  buildMessage(result);

  return result;
}

function timeFormat (m, sbx) {

  var when;
  if (m && sbx.data.inRetroMode) {
    when = m.format('LT');
  } else if (m) {
    when = formatAgo(m, sbx.time);
  } else {
    when = 'unknown';
  }

  return when;
}

function formatAgo (m, nowMills) {
  var ago = timeago.calcDisplay({mills: m.valueOf()}, nowMills);
  return (ago.value ? ago.value : '') + ago.shortLabel + (ago.shortLabel.length === 1 ? ' ago' : '');
}

module.exports = init;