'use strict';

var _ = require('lodash');
var moment = require('moment');

function init() {

  function cage() {
    return cage;
  }

  cage.label = 'Cannula Age';
  cage.pluginType = 'pill-minor';

  cage.checkNotifications = function checkNotifications(sbx) {
  
    var cannulaInfo = cage.findLatestTimeChange(sbx);
    
    // TODO allow user to optionally configure multiple notification times

    if (cannulaInfo.age == 48 || cannulaInfo.age == 72 )
    {
      var title = 'Cannula age ' + cannulaInfo.age +' hours';
      sbx.notifications.requestNotify({
          level: 2
          , title: title
          , message: title + ', time to change?'
          , pushoverSound: 'persistent'
          , plugin: cage
          , debug: {
            cannulaInfo: cannulaInfo
        }
      });
      
    }
  }

<<<<<<< HEAD
    _.forEach(sbx.data.treatments, function eachTreatment (treatment) {
      if (treatment.eventType === 'Site Change') {
        treatmentDate = new Date(treatment.created_at);
        var hours = Math.round(Math.abs(sbx.time - treatmentDate) / 36e5);
=======
  cage.findLatestTimeChange = function findLatestTimeChange(sbx) {
  
  var returnValue = {'message':'', 'found': false, 'age': 0, 'treatmentDate': null};
  
      _.forEach(sbx.data.treatments, function eachTreatment (treatment) {
      if (treatment.eventType == 'Site Change') {
        returnValue.treatmentDate = new Date(treatment.created_at);
        var hours = Math.round(Math.abs(sbx.time - returnValue.treatmentDate) / 36e5);
>>>>>>> Notify user of cannula age upon 48 and 72 hours

        if (!returnValue.found) {
          returnValue.found = true;
          returnValue.age = hours;
        } else {
          if (hours < returnValue.age) {
            returnValue.age = hours;
            if (treatment.notes) {
              returnValue.message = treatment.notes;
            }
          }
        }
      }
    });
    
    return returnValue;

<<<<<<< HEAD
    var info = [{label: 'Inserted:', value: moment(treatmentDate).format('lll')}];
    if (message !== '') { info.push({label: 'Notes:', value: message}); }
=======
  }

  cage.updateVisualisation = function updateVisualisation (sbx) {

    var cannulaInfo = cage.findLatestTimeChange(sbx);

    var info = [{label: 'Inserted:', value: moment(cannulaInfo.treatmentDate).format('lll')}];
    if (cannulaInfo.message != '') info.push({label: 'Notes:', value: cannulaInfo.message});

    var shownAge = cannulaInfo.found ? cannulaInfo.age : 'n/a ';
>>>>>>> Notify user of cannula age upon 48 and 72 hours

    sbx.pluginBase.updatePillText(cage, {
      value: shownAge + 'h'
      , label: 'CAGE'
      , info: info
    });
    
  };

  return cage();
}


module.exports = init;