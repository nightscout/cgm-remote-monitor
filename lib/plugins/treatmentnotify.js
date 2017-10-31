'use strict';

var _ = require('lodash');
var levels = require('../levels');
var times = require('../times');
var simplealarms = require('./simplealarms')();

var OPENAPS_WHITELIST = ['BG Check', 'Meal Bolus', 'Carb Correction', 'Correction Bolus'];

function init() {

  var treatmentnotify = {
    name: 'treatmentnotify'
    , label: 'Treatment Notifications'
    , pluginType: 'notification'
  };

  //automated treatments from OpenAPS shouldn't trigger notifications or snooze alarms
  function filterTreatments (sbx) {
    var treatments = sbx.data.treatments;

    treatments = _.filter(treatments, function notOpenAPS (treatment) {
      var ok = true;
      if (treatment.enteredBy && treatment.enteredBy.indexOf('openaps://') === 0) {
        ok = _.indexOf(OPENAPS_WHITELIST, treatment.eventType) >= 0;
      }
      return ok;
    });

    return treatments;
  }

  treatmentnotify.checkNotifications = function checkNotifications (sbx) {

    var treatments = filterTreatments(sbx);
    var lastMBG = sbx.lastEntry(sbx.data.mbgs);
    var lastTreatment = sbx.lastEntry(treatments);

    var mbgCurrent = isCurrent(lastMBG);
    var treatmentCurrent = isCurrent(lastTreatment);

    if (mbgCurrent || treatmentCurrent) {
      var mbgMessage = mbgCurrent ? 'Meter BG ' + sbx.scaleEntry(lastMBG) + ' ' + sbx.unitsLabel : '';
      var treatmentMessage = treatmentCurrent ? 'Treatment: ' + lastTreatment.eventType : '';

      autoSnoozeAlarms(mbgMessage, treatmentMessage, lastTreatment, sbx);

      //and add some info notifications
      //the notification providers (push, websockets, etc) are responsible to not sending the same notifications repeatedly
      if (mbgCurrent) { requestMBGNotify(lastMBG, sbx); }
      if (treatmentCurrent) {
        requestTreatmentNotify(lastTreatment, sbx);
      }
    }
  };

  function autoSnoozeAlarms(mbgMessage, treatmentMessage, lastTreatment, sbx) {
    //announcements don't snooze alarms
    if (lastTreatment && !lastTreatment.isAnnouncement) {
      var snoozeLength = sbx.extendedSettings.snoozeMins && times.mins(sbx.extendedSettings.snoozeMins).msecs || times.mins(10).msecs;
      sbx.notifications.requestSnooze({
        level: levels.URGENT
        , title: 'Snoozing alarms since there was a recent treatment'
        , message: _.trim([mbgMessage, treatmentMessage].join('\n'))
        , lengthMills: snoozeLength
      });
    }
  }

  function requestMBGNotify (lastMBG, sbx) {
    console.info('requestMBGNotify for', lastMBG);
    sbx.notifications.requestNotify({
      level: levels.INFO
      , title: 'Calibration' //assume all MGBs are calibrations for now
      , message: 'Meter BG: ' + sbx.scaleEntry(lastMBG) + ' ' + sbx.unitsLabel
      , plugin: treatmentnotify
      , pushoverSound: 'magic'
    });
  }

  function requestAnnouncementNotify (lastTreatment, sbx) {
    var result = simplealarms.compareBGToTresholds(sbx.scaleMgdl(lastTreatment.mgdl), sbx);

    sbx.notifications.requestNotify({
      level: result.level
      , title: (result.level === levels.URGENT ? levels.toDisplay(levels.URGENT) + ' ' : '') + lastTreatment.eventType
      , message: lastTreatment.notes || '.' //some message is required
      , plugin: treatmentnotify
      , group: 'Announcement'
      , pushoverSound: levels.isAlarm(result.level) ? result.pushoverSound : undefined
      , isAnnouncement: true
    });
  }

  function requestTreatmentNotify (lastTreatment, sbx) {
    if (lastTreatment.isAnnouncement) {
      requestAnnouncementNotify(lastTreatment, sbx);
    } else {
      var message = buildTreatmentMessage(lastTreatment, sbx);

      var eventType = lastTreatment.eventType;
      if (lastTreatment.duration === 0 && eventType === 'Temporary Target') {
        eventType += ' Cancel';
        message = 'Canceled';
      }

      if (!message) {
        message = '...';
      }

      sbx.notifications.requestNotify({
        level: levels.INFO
        , title: eventType
        , message: message
        , plugin: treatmentnotify
      });
    }
  }

  function buildTreatmentMessage(lastTreatment, sbx) {
    return (lastTreatment.glucose ? 'BG: ' + lastTreatment.glucose + ' (' + lastTreatment.glucoseType + ')' : '') +
      (lastTreatment.reason ? '\nReason: ' + lastTreatment.reason : '') +
      (lastTreatment.targetTop ? '\nTarget Top: ' + lastTreatment.targetTop : '') +
      (lastTreatment.targetBottom ? '\nTarget Bottom: ' + lastTreatment.targetBottom : '') +
      (lastTreatment.carbs ? '\nCarbs: ' + lastTreatment.carbs + 'g' : '') +

      (lastTreatment.insulin ? '\nInsulin: ' + sbx.roundInsulinForDisplayFormat(lastTreatment.insulin) + 'U' : '')+
      (lastTreatment.duration ? '\nDuration: ' + lastTreatment.duration + ' min' : '')+
      (lastTreatment.percent ? '\nPercent: ' + (lastTreatment.percent > 0 ? '+' : '') + lastTreatment.percent + '%' : '')+
      (!isNaN(lastTreatment.absolute) ? '\nValue: ' + lastTreatment.absolute + 'U' : '')+
      (lastTreatment.enteredBy ? '\nEntered By: ' + lastTreatment.enteredBy : '') +

      (lastTreatment.notes ? '\nNotes: ' + lastTreatment.notes : '');
  }

  return treatmentnotify;
}

function isCurrent(last) {
  if (!last) {
    return false;
  }

  var now = Date.now();
  var lastTime = last.mills;
  var ago = (last.mills <= now) ? now - lastTime : -1;
  return ago !== -1 && ago < times.mins(10).msecs;
}

module.exports = init;