'use strict';

var _ = require('lodash');
var moment = require('moment');

var cage = {
  name: 'cage'
  , label: 'Cannula Age'
  , pluginType: 'pill-minor'
};

function init() {
  return cage;
}

module.exports = init;

cage.getPrefs = function getPrefs(sbx) {
  // CAGE_INFO = 44 CAGE_WARN=48 CAGE_URGENT=70
  return {
    'info' : sbx.extendedSettings.info ? sbx.extendedSettings.info : 44,
    'warn' : sbx.extendedSettings.warn ? sbx.extendedSettings.warn : 48,
    'urgent' : sbx.extendedSettings.urgent ? sbx.extendedSettings.urgent : 72,
    'display' : sbx.extendedSettings.display ? sbx.extendedSettings.display : 'hours',
    'enableAlerts' : sbx.extendedSettings.enableAlerts
  };
};

cage.checkNotifications = function checkNotifications(sbx) {

  var cannulaInfo = cage.findLatestTimeChange(sbx);
  var prefs = cage.getPrefs(sbx);

  if (!prefs.enableAlerts || !cannulaInfo.checkForAlert) { return; }
  
  var sendNotification = false;
  var title = 'Cannula age ' + cannulaInfo.age +' hours';  
  var sound = 'incoming';
  var msg = ', change due soon';
  var level = 1;

  if (cannulaInfo.age === Number(prefs.info)) { sendNotification = true; }
  if (cannulaInfo.age === Number(prefs.warn)) { sendNotification = true; msg = ', time to change'; }
  if (cannulaInfo.age === Number(prefs.urgent)) { sendNotification = true; msg = ', change overdue!'; sound = 'persistent'; level = 2;}

  if (sendNotification) {
    sbx.notifications.requestNotify({
      level: level
      , title: title
      , message: title + msg
      , pushoverSound: sound
      , plugin: cage
      , debug: {
        cannulaInfo: cannulaInfo
      }
    });
  }
};

cage.findLatestTimeChange = function findLatestTimeChange(sbx) {

  var returnValue = {'message':'', 'found': false, 'age': 0, 'treatmentDate': null, 'checkForAlert': false};

  var prevDate = 0;

  _.each(sbx.data.sitechangeTreatments, function eachTreatment (treatment) {
    var treatmentDate = treatment.mills;
    if (treatmentDate > prevDate && treatmentDate <= sbx.time) {

      prevDate = treatmentDate;
      returnValue.treatmentDate = treatmentDate;

      //allow for 30 minute period after a full hour during which we'll alert the user
      var a = moment(sbx.time);
      var b = moment(returnValue.treatmentDate);
      var days = a.diff(b,'days');
      var hours = a.diff(b,'hours') - days * 24;
      var age = a.diff(b,'hours');
      var minFractions = a.diff(b,'minutes') - age * 60;
      
      returnValue.checkForAlert = minFractions <= 30;

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

cage.updateVisualisation = function updateVisualisation (sbx) {

  var cannulaInfo = cage.findLatestTimeChange(sbx);
  var prefs = cage.getPrefs(sbx);

  var info = [{ label: 'Inserted', value: new Date(cannulaInfo.treatmentDate).toLocaleString() }];
  if (cannulaInfo.message !== '') { info.push({label: 'Notes:', value: cannulaInfo.message}); }
  var shownAge;
  shownAge = '';
  if (prefs.display === 'days' && cannulaInfo.found) {
    if (cannulaInfo.age >= 24) {
      shownAge += cannulaInfo.days + 'd';
    }
    shownAge += cannulaInfo.hours + 'h';
  } else {
    shownAge = cannulaInfo.found ? cannulaInfo.age + 'h' : 'n/a ';
  }

  sbx.pluginBase.updatePillText(cage, {
    value: shownAge
    , label: 'CAGE'
    , info: info
  });
};