'use strict';

var _ = require('lodash');
var moment = require('moment');

function init(ctx) {
  var translate = ctx.language.translate;
  var levels = ctx.levels;

  var cage = {
    name: 'cage'
    , label: 'Cannula Age'
    , pluginType: 'pill-minor'
  };

  cage.getPrefs = function getPrefs (sbx) {
    // CAGE_INFO = 44 CAGE_WARN=48 CAGE_URGENT=70
    return {
      info: sbx.extendedSettings.info || 44
      , warn: sbx.extendedSettings.warn || 48
      , urgent: sbx.extendedSettings.urgent || 72
      , display: sbx.extendedSettings.display ? sbx.extendedSettings.display : 'hours'
      , enableAlerts: sbx.extendedSettings.enableAlerts || false
    };
  };

  cage.setProperties = function setProperties (sbx) {
    sbx.offerProperty('cage', function setProp ( ) {
      return cage.findLatestTimeChange(sbx);
    });
  };

  cage.checkNotifications = function checkNotifications (sbx) {
    var cannulaInfo = sbx.properties.cage;

    if (cannulaInfo.notification) {
      var notification = _.extend({}, cannulaInfo.notification, {
        plugin: cage
        , debug: {
          age: cannulaInfo.age
        }
      });
      sbx.notifications.requestNotify(notification);
    }
  };

  cage.findLatestTimeChange = function findLatestTimeChange (sbx) {

    var prefs = cage.getPrefs(sbx);

    var cannulaInfo = {
      found: false
      , age: 0
      , treatmentDate: null
      , checkForAlert: false
    };

    var prevDate = 0;

    _.each(sbx.data.sitechangeTreatments, function eachTreatment (treatment) {
      var treatmentDate = treatment.mills;
      if (treatmentDate > prevDate && treatmentDate <= sbx.time) {

        prevDate = treatmentDate;
        cannulaInfo.treatmentDate = treatmentDate;

        var a = moment(sbx.time);
        var b = moment(cannulaInfo.treatmentDate);
        var days = a.diff(b,'days');
        var hours = a.diff(b,'hours') - days * 24;
        var age = a.diff(b,'hours');

        if (!cannulaInfo.found || (age >= 0 && age < cannulaInfo.age)) {
          cannulaInfo.found = true;
          cannulaInfo.age = age;
          cannulaInfo.days = days;
          cannulaInfo.hours = hours;
          cannulaInfo.notes = treatment.notes;
          cannulaInfo.minFractions = a.diff(b,'minutes') - age * 60;
        }
      }
    });

    cannulaInfo.level = levels.NONE;

    var sound = 'incoming';
    var message;
    var sendNotification = false;

    if (cannulaInfo.age >= prefs.urgent) {
      sendNotification = cannulaInfo.age === prefs.urgent;
      message = translate('Cannula change overdue!');
      sound = 'persistent';
      cannulaInfo.level = levels.URGENT;
    } else if (cannulaInfo.age >= prefs.warn) {
      sendNotification = cannulaInfo.age === prefs.warn;
      message = translate('Time to change cannula');
      cannulaInfo.level = levels.WARN;
    } else  if (cannulaInfo.age >= prefs.info) {
      sendNotification = cannulaInfo.age === prefs.info;
      message = 'Change cannula soon';
      cannulaInfo.level = levels.INFO;
    }

    if (prefs.display === 'days' && cannulaInfo.found) {
      cannulaInfo.display = '';
      if (cannulaInfo.age >= 24) {
        cannulaInfo.display += cannulaInfo.days + 'd';
      }
      cannulaInfo.display += cannulaInfo.hours + 'h';
    } else {
      cannulaInfo.display = cannulaInfo.found ? cannulaInfo.age + 'h' : 'n/a ';
    }

    //allow for 20 minute period after a full hour during which we'll alert the user
    if (prefs.enableAlerts && sendNotification && cannulaInfo.minFractions <= 20) {
      cannulaInfo.notification = {
        title: translate('Cannula age %1 hours', { params: [cannulaInfo.age] })
        , message: message
        , pushoverSound: sound
        , level: cannulaInfo.level
        , group: 'CAGE'
      };
    }

    return cannulaInfo;
  };

  cage.updateVisualisation = function updateVisualisation (sbx) {

    var cannulaInfo = sbx.properties.cage;

    var info = [{ label: translate('Inserted'), value: new Date(cannulaInfo.treatmentDate).toLocaleString() }];

    if (!_.isEmpty(cannulaInfo.notes)) {
      info.push({label: translate('Notes') + ':', value: cannulaInfo.notes});
    }

    var statusClass = null;
    if (cannulaInfo.level === levels.URGENT) {
      statusClass = 'urgent';
    } else if (cannulaInfo.level === levels.WARN) {
      statusClass = 'warn';
    }

    sbx.pluginBase.updatePillText(cage, {
      value: cannulaInfo.display
      , label: translate('CAGE')
      , info: info
      , pillClass: statusClass
    });
  };
  return cage;
}

module.exports = init;

