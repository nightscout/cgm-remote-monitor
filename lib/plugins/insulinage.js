'use strict';

var _ = require('lodash');
var moment = require('moment');

var iage = {
  name: 'iage'
  , label: 'Insulin Age'
  , pluginType: 'pill-minor'
};

function init() {
  return iage;
}

module.exports = init;

iage.getPrefs = function getPrefs(sbx) {
  // IAGE_INFO = 44 IAGE_WARN=48 IAGE_URGENT=70
  return {
    'info' : sbx.extendedSettings.info ? sbx.extendedSettings.info : 44,
    'warn' : sbx.extendedSettings.warn ? sbx.extendedSettings.warn : 48,
    'urgent' : sbx.extendedSettings.urgent ? sbx.extendedSettings.urgent : 72,
    'enableAlerts' : sbx.extendedSettings.enableAlerts
  };
};

iage.checkNotifications = function checkNotifications(sbx) {

  var insulinInfo = iage.findLatestTimeChange(sbx);
  var prefs = iage.getPrefs(sbx);

  if (!prefs.enableAlerts || !insulinInfo.checkForAlert) { return; }
  
  var sendNotification = false;
  var title = 'Insulin reservoir age ' + insulinInfo.age +' hours';  
  var sound = 'incoming';
  var msg = ', change due soon';
  var level = 1;

  if (insulinInfo.age === Number(prefs.info)) { sendNotification = true; }
  if (insulinInfo.age === Number(prefs.warn)) { sendNotification = true; msg = ', time to change'; }
  if (insulinInfo.age === Number(prefs.urgent)) { sendNotification = true; msg = ', change overdue!'; sound = 'persistent'; level = 2;}

  if (sendNotification) {
    sbx.notifications.requestNotify({
      level: level
      , title: title
      , message: title + msg
      , pushoverSound: sound
      , plugin: iage
      , debug: {
        insulinInfo: insulinInfo
      }
    });
  }
};

iage.findLatestTimeChange = function findLatestTimeChange(sbx) {

  var returnValue = {'message':'', 'found': false, 'age': 0, 'treatmentDate': null, 'checkForAlert': false};

  var prevDate = 0;

  _.each(sbx.data.insulinchangeTreatments, function eachTreatment (treatment) {
    var treatmentDate = treatment.mills;
    if (treatmentDate > prevDate && treatmentDate <= sbx.time) {

      prevDate = treatmentDate;
      returnValue.treatmentDate = treatmentDate;

      //allow for 10 minute period after a full hour during which we'll alert the user
      var a = moment(sbx.time);
      var b = moment(returnValue.treatmentDate);
      var days = a.diff(b,'days');
      var hours = a.diff(b,'hours') - days * 24;
      var age = a.diff(b,'hours');
      var minFractions = a.diff(b,'minutes') - age * 60;
      
      returnValue.checkForAlert = minFractions <= 10;

      if (!returnValue.found) {
        returnValue.found = true;
        returnValue.age = age;
        returnValue.days = days;
        returnValue.hours = hours;
      } else {
        if (age >= 0 && age < returnValue.age) {
            returnValue.age = age;
            returnValue.days = days;
            returnValue.hours = hours;
          if (treatment.notes) {
            returnValue.message = treatment.notes;
          } else {
            returnValue.message = '';
          }
        }
      }
    }
  });

  return returnValue;
};

iage.updateVisualisation = function updateVisualisation (sbx) {

  var insulinInfo = iage.findLatestTimeChange(sbx);

  var info = [{ label: 'Changed', value: new Date(insulinInfo.treatmentDate).toLocaleString() }];
  if (insulinInfo.message !== '') { info.push({label: 'Notes:', value: insulinInfo.message}); }
  var shownAge;
  shownAge = '';
  if (insulinInfo.found) {
    if (insulinInfo.age >= 24) {
      shownAge += insulinInfo.days + 'd';
    }
    shownAge += insulinInfo.hours + 'h';
  } else {
    shownAge = insulinInfo.found ? insulinInfo.age + 'h' : 'n/a ';
  }

  sbx.pluginBase.updatePillText(iage, {
    value: shownAge
    , label: 'IAGE'
    , info: info
  });
};