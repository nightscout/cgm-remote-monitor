'use strict';

var _ = require('lodash');
var moment = require('moment');
var times = require('../times');
var levels = require('../levels');

var sage = {
  name: 'sage'
  , label: 'Sensor Age'
  , pluginType: 'pill-minor'
};

function init() {
  return sage;
}

module.exports = init;

sage.getPrefs = function getPrefs(sbx) {
  return {
    info: sbx.extendedSettings.info || times.days(6).hours
    , warn: sbx.extendedSettings.warn || (times.days(7).hours - 4)
    , urgent: sbx.extendedSettings.urgent || (times.days(7).hours - 2)
    , enableAlerts: sbx.extendedSettings.enableAlerts || false
  };
};

sage.checkNotifications = function checkNotifications(sbx) {

  var info = sage.findLatestTimeChange(sbx);
  var sensorInfo = info[info.min];

  if (sensorInfo.notification) {
    sbx.notifications.requestNotify(sensorInfo.notification);
  }

};

function minButValid(record) {
  if (!record['Sensor Start'].age) {
    return 'Sensor Change';
  }
  if (!record['Sensor Change'].age) {
    return 'Sensor Start';
  }
  if (record['Sensor Start'].age < record['Sensor Change'].age) {
    return 'Sensor Start';
  }
  if (record['Sensor Start'].age > record['Sensor Change'].age) {
    return 'Sensor Change';
  }
  return 'Sensor Start';
}

sage.findLatestTimeChange = function findLatestTimeChange(sbx) {

  var returnValue = {
    'Sensor Start': {
      found: false
      , age: 0
      , treatmentDate: null
    }
    , 'Sensor Change': {
      found: false
      , age: 0
      , treatmentDate: null
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
        returnValue[event].treatmentDate = treatmentDate;

        //allow for 30 minute period after a full hour during which we'll alert the user
        var a = moment(sbx.time);
        var b = moment(returnValue[event].treatmentDate);
        var days = a.diff(b,'days');
        var hours = a.diff(b,'hours') - days * 24;
        var age = a.diff(b,'hours');

        if (!returnValue[event].found || (age >= 0 && age < returnValue[event].age)) {
          returnValue[event].found = true;
          returnValue[event].age = age;
          returnValue[event].days = days;
          returnValue[event].hours = hours;
          returnValue[event].notes = treatment.notes;
          returnValue[event].minFractions = a.diff(b,'minutes') - age * 60;
        }
      }
    });
  });
  
  // clear Sensor Start if both found and Sensort Change is newer
  if (returnValue['Sensor Change'].found && returnValue['Sensor Start'].found && returnValue['Sensor Start'].treatmentDate < returnValue['Sensor Change'].treatmentDate) {
    returnValue['Sensor Start'] = {'message':'', 'found': false, 'age': 0, 'treatmentDate': null, 'checkForAlert': false};
  }

  returnValue.min = minButValid(returnValue);

  var sensorInfo = returnValue[returnValue.min];
  var prefs = sage.getPrefs(sbx);

  var sendNotification = false;
  var sound = 'incoming';
  var message;

  sensorInfo.level = levels.NONE;

  if (sensorInfo.age > prefs.urgent) {
    sendNotification = sensorInfo.age === prefs.urgent;
    message = 'Sensor change/restart overdue!';
    sound = 'persistent';
    sensorInfo.level = levels.URGENT;
  } else if (sensorInfo.age > prefs.warn) {
    sendNotification = sensorInfo.age === prefs.warn;
    message = 'Time to change/restart sensor';
    sensorInfo.level = levels.WARN;
  } else if (sensorInfo.age >= prefs.info) {
    sendNotification = sensorInfo.age === prefs.info;
    message = 'Change/restart sensor soon';
    sensorInfo.level = levels.INFO;
  }

  if (prefs.enableAlerts && sendNotification && sensorInfo.minFractions <= 30) {
    sensorInfo.notification = {
      title: 'Sensor age ' + sensorInfo.days + ' days' + sensorInfo.hours +' hours'
      , message: message
      , pushoverSound: sound
      , level: sensorInfo.level
      , plugin: sage
      , group: 'SAGE'
      , debug: {
        age: sensorInfo.age
      }
    };
  }

  return returnValue;
};

sage.updateVisualisation = function updateVisualisation (sbx) {

  var latest = sage.findLatestTimeChange(sbx);
  var sensorInfo = latest[latest.min];
  var info = [];
  var shownAge;

  ['Sensor Change', 'Sensor Start'].forEach( function eachEvent(event) {
    if (latest[event].found) {
      info.push( { label: event, value: new Date(latest[event].treatmentDate).toLocaleString() } );
      shownAge = '';
      if (latest[event].age > 24) {
        shownAge += latest[event].days + ' days ';
      }
      shownAge += latest[event].hours + ' hours';
      info.push( { label: 'Duration', value: shownAge } );
      if (!_.isEmpty(latest[event].notes)) {
        info.push({label: 'Notes:', value: latest[event].notes});
      }
    }
  });
  shownAge = '';
  if (sensorInfo.found) {
    if (sensorInfo.age >= 24) {
      shownAge += latest[latest.min].days + 'd';
    }
    shownAge += latest[latest.min].hours + 'h';
  } else {
    shownAge = 'n/a ';
  }

  var statusClass = null;
  if (sensorInfo.level === levels.URGENT) {
    statusClass = 'urgent';
  } else if (sensorInfo.level === levels.WARN) {
    statusClass = 'warn';
  }

  sbx.pluginBase.updatePillText(sage, {
    value: shownAge
    , label: 'SAGE'
    , info: info
    , pillClass: statusClass
  });
};