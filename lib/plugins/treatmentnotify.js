'use strict';

var _ = require('lodash');
var levels = require('../levels');
var simplealarms = require('./simplealarms')();

var TIME_10_MINS_MS = 10 * 60 * 1000;

function init() {

  var treatmentnotify = {
    name: 'treatmentnotify'
    , label: 'Treatment Notifications'
    , pluginType: 'notification'
  };

  treatmentnotify.checkNotifications = function checkNotifications (sbx) {
    var lastMBG = sbx.lastEntry(sbx.data.mbgs);
    var lastTreatment = sbx.lastEntry(sbx.data.treatments);

    var mbgCurrent = isCurrent(lastMBG);
    var treatmentCurrent = isCurrent(lastTreatment);

    if (mbgCurrent || treatmentCurrent) {
      var mbgMessage = mbgCurrent ? 'Meter BG ' + sbx.scaleEntry(lastMBG) + ' ' + sbx.unitsLabel : '';
      var treatmentMessage = treatmentCurrent ? 'Treatment: ' + lastTreatment.eventType : '';

      var isAnnouncement = lastTreatment.eventType === 'Announcement';
      if (!isAnnouncement) {
        autoSnoozeAlarms(mbgMessage, treatmentMessage, sbx);
      }

      //and add some info notifications
      //the notification providers (push, websockets, etc) are responsible to not sending the same notifications repeatedly
      if (mbgCurrent) { requestMBGNotify(lastMBG, sbx); }
      if (treatmentCurrent && isAnnouncement) {
        requestAnnouncementNotify(lastTreatment, sbx);
      } else if (treatmentCurrent) {
        requestTreatmentNotify(lastTreatment, sbx);
      }
    }
  };

  function autoSnoozeAlarms(mbgMessage, treatmentMessage, sbx) {
    var snoozeLength = (sbx.extendedSettings.snoozeMins && Number(sbx.extendedSettings.snoozeMins) * 60 * 1000) || TIME_10_MINS_MS;
    sbx.notifications.requestSnooze({
      level: levels.URGENT
      , title: 'Snoozing alarms since there was a recent treatment'
      , message: _.trim([mbgMessage, treatmentMessage].join('\n'))
      , lengthMills: snoozeLength
    });
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
      , message: lastTreatment.notes || ''
      , plugin: treatmentnotify
      , pushoverSound: levels.isAlarm(result.level) ? result.pushoverSound : undefined
      , announcement: true
    });
  }

  function requestTreatmentNotify (lastTreatment, sbx) {
    var message = buildTreatmentMessage(lastTreatment, sbx);

    sbx.notifications.requestNotify({
      level: levels.INFO
      , title: lastTreatment.eventType
      , message: message
      , plugin: treatmentnotify
    });
  }

  function buildTreatmentMessage(lastTreatment, sbx) {
    return (lastTreatment.glucose ? 'BG: ' + lastTreatment.glucose + ' (' + lastTreatment.glucoseType + ')' : '') +
      (lastTreatment.carbs ? '\nCarbs: ' + lastTreatment.carbs + 'g' : '') +

      (lastTreatment.insulin ? '\nInsulin: ' + sbx.roundInsulinForDisplayFormat(lastTreatment.insulin) + 'U' : '')+
      (lastTreatment.enteredBy ? '\nEntered By: ' + lastTreatment.enteredBy : '') +

      (lastTreatment.notes ? '\nNotes: ' + lastTreatment.notes : '');
  }

  return treatmentnotify;
}

function isCurrent(last) {
  var now = Date.now();
  var lastTime = last ? last.mills : 0;
  var ago = (lastTime && lastTime <= now) ? now - lastTime : -1;
  return ago !== -1 && ago < TIME_10_MINS_MS;
}

module.exports = init;