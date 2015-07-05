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
  
    // Just return if no notification times are configured
  
  	if (!sbx.extendedSettings.urgent && !sbx.extendedSettings.warn) {
  	  return;
  	}
  
    var cannulaInfo = cage.findLatestTimeChange(sbx);

	if (!cannulaInfo.checkForAlert) {
	  return;
	}
    
    // CAGE_WARN=48 CAGE_URGENT=70

    if (cannulaInfo.age === sbx.extendedSettings.urgent || cannulaInfo.age === sbx.extendedSettings.warn )
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

  function frac(f) {
    return f % 1;
  }

  cage.findLatestTimeChange = function findLatestTimeChange(sbx) {
  
  var returnValue = {'message':'', 'found': false, 'age': 0, 'treatmentDate': null, 'checkForAlert': false};
  
      _.forEach(sbx.data.treatments, function eachTreatment (treatment) {
      if (treatment.eventType === 'Site Change') {
        returnValue.treatmentDate = new Date(treatment.created_at);
        var hours = Math.round(Math.abs(sbx.time - returnValue.treatmentDate) / 36e5);

        //allow for around 10 minute period after a full hour during which we'll alert the user
        returnValue.checkForAlert = frac(Math.abs(sbx.time - returnValue.treatmentDate) / 36e5) < 0.15;

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

  return cage();
}


module.exports = init;