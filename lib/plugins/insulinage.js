'use strict';

var _ = require('lodash');
var moment = require('moment');
var levels = require('../levels');

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
  // IAGE_INFO=44 IAGE_WARN=48 IAGE_URGENT=70
  return {
    info: sbx.extendedSettings.info || 44
    , warn: sbx.extendedSettings.warn || 48
    , urgent: sbx.extendedSettings.urgent || 72
    , enableAlerts: sbx.extendedSettings.enableAlerts || false
  };
};

iage.checkNotifications = function checkNotifications(sbx) {
  var insulinInfo = iage.findLatestTimeChange(sbx);

  if (insulinInfo.notification) {
    sbx.notifications.requestNotify(insulinInfo.notification);
  }
};

iage.findLatestTimeChange = function findLatestTimeChange(sbx) {

  var insulinInfo = {
    found: false
    , age: 0
    , treatmentDate: null
  };

  var prevDate = 0;

  _.each(sbx.data.insulinchangeTreatments, function eachTreatment (treatment) {
    var treatmentDate = treatment.mills;
    if (treatmentDate > prevDate && treatmentDate <= sbx.time) {

      prevDate = treatmentDate;
      insulinInfo.treatmentDate = treatmentDate;

      //allow for 30 minute period after a full hour during which we'll alert the user
      var a = moment(sbx.time);
      var b = moment(insulinInfo.treatmentDate);
      var days = a.diff(b,'days');
      var hours = a.diff(b,'hours') - days * 24;
      var age = a.diff(b,'hours');

      if (!insulinInfo.found || (age >= 0 && age < insulinInfo.age)) {
        insulinInfo.found = true;
        insulinInfo.age = age;
        insulinInfo.days = days;
        insulinInfo.hours = hours;
        insulinInfo.notes = treatment.notes;
        insulinInfo.minFractions = a.diff(b,'minutes') - age * 60;
      }
    }
  });

  var prefs = iage.getPrefs(sbx);

  insulinInfo.level = levels.NONE;

  var sound = 'incoming';
  var message;
  var sendNotification = false;

  if (insulinInfo.age >= insulinInfo.urgent) {
    sendNotification = insulinInfo.age === prefs.urgent;
    message = 'Insulin reservoir change overdue!';
    sound = 'persistent';
    insulinInfo.level = levels.URGENT;
  } else if (insulinInfo.age >= prefs.warn) {
    sendNotification = insulinInfo.age === prefs.warn;
    message = 'Time to change insulin reservoir';
    insulinInfo.level = levels.WARN;
  } else  if (insulinInfo.age >= prefs.info) {
    sendNotification = insulinInfo.age === prefs.info;
    message = 'Change insulin reservoir soon';
    insulinInfo.level = levels.INFO;
  }

  if (prefs.enableAlerts && sendNotification && insulinInfo.minFractions <= 30) {
    insulinInfo.notification = {
      title: 'Insulin reservoir age ' + insulinInfo.age +' hours'
      , message: message
      , pushoverSound: sound
      , level: insulinInfo.level
      , plugin: iage
      , group: 'IAGE'
      , debug: {
        age: insulinInfo.age
      }
    };
  }

  return insulinInfo;
};

iage.updateVisualisation = function updateVisualisation (sbx) {

  var insulinInfo = iage.findLatestTimeChange(sbx);

  var info = [{ label: 'Changed', value: new Date(insulinInfo.treatmentDate).toLocaleString() }];
  if (!_.isEmpty(insulinInfo.notes)) {
    info.push({label: 'Notes:', value: insulinInfo.notes});
  }

  var shownAge = '';
  if (insulinInfo.found) {
    if (insulinInfo.age >= 24) {
      shownAge += insulinInfo.days + 'd';
    }
    shownAge += insulinInfo.hours + 'h';
  } else {
    shownAge = insulinInfo.found ? insulinInfo.age + 'h' : 'n/a ';
  }

  var statusClass = null;
  if (insulinInfo.level === levels.URGENT) {
    statusClass = 'urgent';
  } else if (insulinInfo.level === levels.WARN) {
    statusClass = 'warn';
  }
  sbx.pluginBase.updatePillText(iage, {
    value: shownAge
    , label: 'IAGE'
    , info: info
    , pillClass: statusClass
  });
};