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

  _.forEach(sbx.data.treatments, function eachTreatment (treatment) {
    var treatmentDate = treatment.mills;
    if (treatment.eventType === 'Site Change' && treatmentDate > prevDate && treatmentDate <= sbx.time) {

      prevDate = treatmentDate;
      returnValue.treatmentDate = treatmentDate;

      //allow for 10 minute period after a full hour during which we'll alert the user
      var a = moment(sbx.time);
      var b = moment(returnValue.treatmentDate);
      var hours = a.diff(b,'hours');
      var minFractions = a.diff(b,'minutes') - hours * 60;
      
      returnValue.checkForAlert = minFractions <= 10;

      if (!returnValue.found) {
        returnValue.found = true;
        returnValue.age = hours;
      } else {
        if (hours >= 0 && hours < returnValue.age) {
          returnValue.age = hours;
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

  var info = [{label: 'Inserted:', value: moment(cannulaInfo.treatmentDate).format('lll')}];
  if (cannulaInfo.message !== '') { info.push({label: 'Notes:', value: cannulaInfo.message}); }

  var shownAge = cannulaInfo.found ? cannulaInfo.age : 'n/a ';

  sbx.pluginBase.updatePillText(cage, {
    value: shownAge + 'h'
    , label: 'CAGE'
    , info: info
  });
};