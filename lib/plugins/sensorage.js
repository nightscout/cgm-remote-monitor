'use strict';

var _ = require('lodash');
var moment = require('moment');
var times = require('../times');

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
  // SAGE_INFO = 6d SAGE_WARN=6d20h SAGE_URGENT=6d22h
  return {
    'info' : sbx.extendedSettings.info ? sbx.extendedSettings.info : times.days(6).hours,
    'warn' : sbx.extendedSettings.warn ? sbx.extendedSettings.warn : times.days(7).hours - 4,
    'urgent' : sbx.extendedSettings.urgent ? sbx.extendedSettings.urgent : times.days(7).hours - 2,
    'enableAlerts' : sbx.extendedSettings.enableAlerts
  };
};

sage.checkNotifications = function checkNotifications(sbx) {

  var info = sage.findLatestTimeChange(sbx);
  var sensorInfo = info[info.min];
  var prefs = sage.getPrefs(sbx);

  if (!prefs.enableAlerts || !sensorInfo.checkForAlert) { return; }
  
  var sendNotification = false;
  var title = 'Sensor age ' + sensorInfo.days +' days' + sensorInfo.hours +' hours';
  var sound = 'incoming';
  var msg = ', change due soon';
  var level = 1;

  if (sensorInfo.age === Number(prefs.info)) { sendNotification = true; }
  if (sensorInfo.age === Number(prefs.warn)) { sendNotification = true; msg = ', time to change'; }
  if (sensorInfo.age === Number(prefs.urgent)) { sendNotification = true; msg = ', sensor will stop!'; sound = 'persistent'; level = 2;}

  if (sendNotification) {
    sbx.notifications.requestNotify({
      level: level
      , title: title
      , message: title + msg
      , pushoverSound: sound
      , plugin: sage
      , debug: {
        sensorInfo: sensorInfo
      }
    });
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
    'Sensor Start': {'message':'', 'found': false, 'age': 0, 'treatmentDate': null, 'checkForAlert': false}
    , 'Sensor Change': {'message':'', 'found': false, 'age': 0, 'treatmentDate': null, 'checkForAlert': false}
  };

  var prevDate = {
    'Sensor Start': 0
    ,'Sensor Change': 0
  };

  _.each(sbx.data.sensorTreatments, function eachTreatment (treatment) {
    ['Sensor Start', 'Sensor Change'].forEach( function eachEvent(event) {
      var treatmentDate = treatment.mills;
      if (treatment.eventType === event && treatmentDate > prevDate[event] && treatmentDate <= sbx.time) {

        prevDate[event] = treatmentDate;
        returnValue[event].treatmentDate = treatmentDate;

        //allow for 10 minute period after a full hour during which we'll alert the user
        var a = moment(sbx.time);
        var b = moment(returnValue[event].treatmentDate);
        var days = a.diff(b,'days');
        var hours = a.diff(b,'hours') - days * 24;
        var age = a.diff(b,'hours');
        var minFractions = a.diff(b,'minutes') - age * 60;
        
        returnValue[event].checkForAlert = minFractions <= 10;

        if (!returnValue[event].found) {
          returnValue[event].found = true;
          returnValue[event].age = age;
          returnValue[event].days = days;
          returnValue[event].hours = hours;
        } else {
          if (age >= 0 && age < returnValue[event].age) {
            returnValue[event].age = age;
            returnValue[event].days = days;
            returnValue[event].hours = hours;
            if (treatment.notes) {
              returnValue[event].message = treatment.notes;
            } else {
              returnValue[event].message = '';
            }
          }
        }
      }
    });
  });
  
  // clear Sensor Start if both found and Sensort Change is newer
  if (returnValue['Sensor Change'].found && returnValue['Sensor Start'].found && returnValue['Sensor Start'].treatmentDate < returnValue['Sensor Change'].treatmentDate) {
    returnValue['Sensor Start'] = {'message':'', 'found': false, 'age': 0, 'treatmentDate': null, 'checkForAlert': false};
  }
  returnValue.min = minButValid(returnValue);

  return returnValue;
};

sage.updateVisualisation = function updateVisualisation (sbx) {

  var sensorInfo = sage.findLatestTimeChange(sbx);
  var info = [];
  var shownAge;

  ['Sensor Change', 'Sensor Start'].forEach( function eachEvent(event) {
    if (sensorInfo[event].found) {
      info.push( { label: event, value: new Date(sensorInfo[event].treatmentDate).toLocaleString() } );
      shownAge = '';
      if (sensorInfo[event].age > 24) {
        shownAge += sensorInfo[event].days + ' days ';
      }
      shownAge += sensorInfo[event].hours + ' hours';
      info.push( { label: 'Duration', value: shownAge } );
      if (sensorInfo[event].message !== '') { 
        info.push({label: 'Notes:', value: sensorInfo[event].message}); 
      }
    }
  });
  shownAge = '';
  if (sensorInfo[sensorInfo.min].found) {
    if (sensorInfo[sensorInfo.min].age >= 24) {
      shownAge += sensorInfo[sensorInfo.min].days + 'd';
    }
    shownAge += sensorInfo[sensorInfo.min].hours + 'h';
  } else {
    shownAge = 'n/a ';
  }

  sbx.pluginBase.updatePillText(sage, {
    value: shownAge
    , label: 'SAGE'
    , info: info
  });
};