'use strict';

var _ = require('lodash');
var moment = require('moment');
var times = require('../times');

function init(ctx) {
  var translate = ctx.language.translate;
  var levels = ctx.levels;

  var sage = {
    name: 'sage'
    , label: 'Sensor Age'
    , pluginType: 'pill-minor'
  };

  sage.getPrefs = function getPrefs(sbx) {
    return {
      info: sbx.extendedSettings.info || times.days(6).hours
      , warn: sbx.extendedSettings.warn || (times.days(7).hours - 4)
      , urgent: sbx.extendedSettings.urgent || (times.days(7).hours - 2)
      , enableAlerts: sbx.extendedSettings.enableAlerts || false
    };
  };

  sage.setProperties = function setProperties (sbx) {
    sbx.offerProperty('sage', function setProp ( ) {
      return sage.findLatestTimeChange(sbx);
    });
  };

  sage.checkNotifications = function checkNotifications(sbx) {

    var info = sbx.properties.sage;
    var sensorInfo = info[info.min];

    if (sensorInfo.notification) {
      var notification = _.extend({}, sensorInfo.notification, {
        plugin: sage
        , debug: {
          age: sensorInfo.age
        }
      });

      sbx.notifications.requestNotify(notification);
    }

  };

  function minButValid(record) {
    var events = [ ];

    var start = record['Sensor Start'];
    if (start && start.found) {
      events.push({eventType: 'Sensor Start', treatmentDate: start.treatmentDate});
    }

    var change = record['Sensor Change'];
    if (change && change.found) {
      events.push({eventType: 'Sensor Change', treatmentDate: change.treatmentDate});
    }

    var sorted = _.sortBy(events, 'treatmentDate');

    var mostRecent = _.last(sorted);

    return (mostRecent && mostRecent.eventType) || 'Sensor Start';
  }

  sage.findLatestTimeChange = function findLatestTimeChange(sbx) {

    var returnValue = {
      'Sensor Start': {
        found: false
      }
      , 'Sensor Change': {
        found: false
      }
    };

    var prevDate = {
      'Sensor Start': 0
      , 'Sensor Change': 0
    };

    _.each(sbx.data.sensorTreatments, function eachTreatment (treatment) {
      ['Sensor Start', 'Sensor Change'].forEach( function eachEvent(event) {
        var treatmentDate = treatment.mills;
        if (treatment.eventType === event && treatmentDate > prevDate[event] && treatmentDate <= sbx.time) {

          prevDate[event] = treatmentDate;

          var a = moment(sbx.time);
          var b = moment(treatmentDate);
          var days = a.diff(b,'days');
          var hours = a.diff(b,'hours') - days * 24;
          var age = a.diff(b,'hours');

          var eventValue = returnValue[event];
          if (!eventValue.found || (age >= 0 && age < eventValue.age)) {
            eventValue.found = true;
            eventValue.treatmentDate = treatmentDate;
            eventValue.age = age;
            eventValue.days = days;
            eventValue.hours = hours;
            eventValue.notes = treatment.notes;
            eventValue.minFractions = a.diff(b,'minutes') - age * 60;

            eventValue.display = '';
            if (eventValue.age >= 24) {
              eventValue.display += eventValue.days + 'd';
            }
            eventValue.display += eventValue.hours + 'h';

            eventValue.displayLong = '';
            if (eventValue.age >= 24) {
              eventValue.displayLong += eventValue.days + ' ' + translate('days');
            }
            if (eventValue.displayLong.length > 0) {
              eventValue.displayLong += ' ';
            }
            eventValue.displayLong += eventValue.hours + ' ' + translate('hours');
          }
        }
      });
    });

    if (returnValue['Sensor Change'].found && returnValue['Sensor Start'].found &&
        returnValue['Sensor Change'].treatmentDate >= returnValue['Sensor Start'].treatmentDate) {
      returnValue['Sensor Start'].found = false;
    }

    returnValue.min = minButValid(returnValue);

    var sensorInfo = returnValue[returnValue.min];
    var prefs = sage.getPrefs(sbx);

    var sendNotification = false;
    var sound = 'incoming';
    var message;

    sensorInfo.level = levels.NONE;

    if (sensorInfo.age >= prefs.urgent) {
      sendNotification = sensorInfo.age === prefs.urgent;
      message = translate('Sensor change/restart overdue!');
      sound = 'persistent';
      sensorInfo.level = levels.URGENT;
    } else if (sensorInfo.age >= prefs.warn) {
      sendNotification = sensorInfo.age === prefs.warn;
      message = translate('Time to change/restart sensor');
      sensorInfo.level = levels.WARN;
    } else if (sensorInfo.age >= prefs.info) {
      sendNotification = sensorInfo.age === prefs.info;
      message = translate('Change/restart sensor soon');
      sensorInfo.level = levels.INFO;
    }

    //allow for 20 minute period after a full hour during which we'll alert the user
    if (prefs.enableAlerts && sendNotification && sensorInfo.minFractions <= 20) {
      sensorInfo.notification = {
        title: translate('Sensor age %1 days %2 hours', { params: [sensorInfo.days, sensorInfo.hours] })
        , message: message
        , pushoverSound: sound
        , level: sensorInfo.level
        , group: 'SAGE'
      };
    }

    return returnValue;
  };

  sage.updateVisualisation = function updateVisualisation (sbx) {

    var latest = sbx.properties.sage;
    var sensorInfo = latest[latest.min];
    var info = [];

    ['Sensor Change', 'Sensor Start'].forEach( function eachEvent(event) {
      if (latest[event].found) {
        var label = event === 'Sensor Change' ? 'Sensor Insert' : event;
        info.push( { label: translate(label), value: new Date(latest[event].treatmentDate).toLocaleString() } );
        info.push( { label: translate('Duration'), value: latest[event].displayLong } );
        if (!_.isEmpty(latest[event].notes)) {
          info.push({label: translate('Notes'), value: latest[event].notes});
        }
      }
    });

    var statusClass = null;
    if (sensorInfo.level === levels.URGENT) {
      statusClass = 'urgent';
    } else if (sensorInfo.level === levels.WARN) {
      statusClass = 'warn';
    }

    sbx.pluginBase.updatePillText(sage, {
      value: sensorInfo.display
      , label: translate('SAGE')
      , info: info
      , pillClass: statusClass
    });
  };

  return sage;
}

module.exports = init;

