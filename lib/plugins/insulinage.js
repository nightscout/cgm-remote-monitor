'use strict';

var _ = require('lodash');
var moment = require('moment');

function init(ctx) {
  var translate = ctx.language.translate;
  var levels = ctx.levels;

  var iage = {
    name: 'iage'
    , label: 'Insulin Age'
    , pluginType: 'pill-minor'
  };

  iage.getPrefs = function getPrefs(sbx) {
    // IAGE_INFO=44 IAGE_WARN=48 IAGE_URGENT=70
    return {
      info: sbx.extendedSettings.info || 44
      , warn: sbx.extendedSettings.warn || 48
      , urgent: sbx.extendedSettings.urgent || 72
      , enableAlerts: sbx.extendedSettings.enableAlerts || false
    };
  };

  iage.setProperties = function setProperties (sbx) {
    sbx.offerProperty('iage', function setProp ( ) {
      return iage.findLatestTimeChange(sbx);
    });
  };

  iage.checkNotifications = function checkNotifications(sbx) {
    var insulinInfo = sbx.properties.iage;

    if (insulinInfo.notification) {
      var notification = _.extend({}, insulinInfo.notification, {
        plugin: iage
        , debug: {
          age: insulinInfo.age
        }
      });

      sbx.notifications.requestNotify(notification);
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

          insulinInfo.display = '';
          if (insulinInfo.age >= 24) {
            insulinInfo.display += insulinInfo.days + 'd';
          }
          insulinInfo.display += insulinInfo.hours + 'h';
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
      message = translate('Insulin reservoir change overdue!');
      sound = 'persistent';
      insulinInfo.level = levels.URGENT;
    } else if (insulinInfo.age >= prefs.warn) {
      sendNotification = insulinInfo.age === prefs.warn;
      message = translate('Time to change insulin reservoir');
      insulinInfo.level = levels.WARN;
    } else  if (insulinInfo.age >= prefs.info) {
      sendNotification = insulinInfo.age === prefs.info;
      message = translate('Change insulin reservoir soon');
      insulinInfo.level = levels.INFO;
    }

    //allow for 20 minute period after a full hour during which we'll alert the user
    if (prefs.enableAlerts && sendNotification && insulinInfo.minFractions <= 20) {
      insulinInfo.notification = {
        title: translate('Insulin reservoir age %1 hours', { params: [insulinInfo.age] })
        , message: message
        , pushoverSound: sound
        , level: insulinInfo.level
        , group: 'IAGE'
      };
    }

    return insulinInfo;
  };

  iage.updateVisualisation = function updateVisualisation (sbx) {

    var insulinInfo = sbx.properties.iage;

    var info = [{ label: translate('Changed'), value: new Date(insulinInfo.treatmentDate).toLocaleString() }];
    if (!_.isEmpty(insulinInfo.notes)) {
      info.push({label: translate('Notes:'), value: insulinInfo.notes});
    }

    var statusClass = null;
    if (insulinInfo.level === levels.URGENT) {
      statusClass = 'urgent';
    } else if (insulinInfo.level === levels.WARN) {
      statusClass = 'warn';
    }
    sbx.pluginBase.updatePillText(iage, {
      value: insulinInfo.display
      , label: translate('IAGE')
      , info: info
      , pillClass: statusClass
    });
  };

  return iage;
}

module.exports = init;

