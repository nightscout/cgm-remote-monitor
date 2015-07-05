'use strict';

var _ = require('lodash');
var moment = require('moment');

function cage() {
  return cage;
}

function init() {
  return cage();
}

module.exports = init;

cage.label = 'Cannula Age';
cage.pluginType = 'pill-minor';

cage.checkNotifications = function checkNotifications(sbx) {

  if (!sbx.extendedSettings.enablealerts) { return; }

  var cannulaInfo = cage.findLatestTimeChange(sbx);

  if (!cannulaInfo.checkForAlert) { return; }

  // CAGE_INFO = 44 CAGE_WARN=48 CAGE_URGENT=70
  
  var info = sbx.extendedSettings.info ? sbx.extendedSettings.info : 44;
  var warn = sbx.extendedSettings.warn ? sbx.extendedSettings.warn : 48;
  var urgent = sbx.extendedSettings.urgent ? sbx.extendedSettings.urgent : 72;

  if (cannulaInfo.age === info || cannulaInfo.age === urgent || cannulaInfo.age === warn )
  {
    var title = 'Cannula age ' + cannulaInfo.age +' hours';
    
    var sound = 'incoming';
    var msg = ', change due soon';
    if (cannulaInfo.age === warn) { msg = 'time to change'; }
    if (cannulaInfo.age === urgent) { msg = 'change overdue!'; sound = 'persistent'; }
    
    sbx.notifications.requestNotify({
      level: 2
      , title: title
      , message: title + msg
      , pushoverSound: sound
      , plugin: cage
      , debug: {
        cannulaInfo: cannulaInfo
      }
    });

  }
}

function frac(f) {
  return f % 1;
}

cage.findLatestTimeChange = function findLatestTimeChange(sbx) {

  var returnValue = {'message':'', 'found': false, 'age': 0, 'treatmentDate': null, 'checkForAlert': false};

  var prevDate = new Date('1900-01-01');

  _.forEach(sbx.data.treatments, function eachTreatment (treatment) {
    var treatmentDate = new Date(treatment.created_at);
    if (treatment.eventType === 'Site Change' && treatmentDate > prevDate && treatmentDate < sbx.time) {
    
      prevDate = treatmentDate;
      returnValue.treatmentDate = treatmentDate;

      //allow for 10 minute period after a full hour during which we'll alert the user
      var a = moment(sbx.time);
      var b = moment(returnValue.treatmentDate);
      var hours = a.diff(b,'hours');
      var minFractions = a.diff(b,'minutes') - hours * 60;
      
      returnValue.checkForAlert = minFractions <= 10 ? true : false;
      
      if (!returnValue.found) {
        returnValue.found = true;
        returnValue.age = hours;
      } else {
        if (hours > 0 && hours < returnValue.age) {
          returnValue.age = hours;
          if (treatment.notes) {
            returnValue.message = treatment.notes;
          }
        }
      }
    }
  });

  return returnValue;
}

cage.updateVisualisation = function updateVisualisation (sbx) {

  var cannulaInfo = cage.findLatestTimeChange(sbx);

  var info = [{label: 'Inserted:', value: moment(cannulaInfo.treatmentDate).format('lll')}];
  if (cannulaInfo.message !== '') info.push({label: 'Notes:', value: cannulaInfo.message});

  var shownAge = cannulaInfo.found ? cannulaInfo.age : 'n/a ';

  sbx.pluginBase.updatePillText(cage, {
    value: shownAge + 'h'
    , label: 'CAGE'
    , info: info
  });
};