'use strict';

var _ = require('lodash');
var levels = require('../levels');

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
      autoSnoozeAlarms(mbgMessage, treatmentMessage, sbx);
      //and add some info notifications
      //the notification providers (push, websockets, etc) are responsible to not sending the same notifications repeatedly
      if (mbgCurrent) { requestMBGNotify(lastMBG, sbx); }
      if (treatmentCurrent) { requestTreatmentNotify(lastTreatment, sbx); }
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

  function requestTreatmentNotify (lastTreatment, sbx) {
    var message = (lastTreatment.glucose ? 'BG: ' + lastTreatment.glucose + ' (' + lastTreatment.glucoseType + ')' : '') +
      (lastTreatment.carbs ? '\nCarbs: ' + lastTreatment.carbs + 'g' : '') +

      //TODO: find a better way to connect split treatments
      //(preBolusCarbs ? '\nCarbs: ' + preBolusCarbs + ' (in ' + treatment.preBolus + ' minutes)' : '')+

      (lastTreatment.insulin ? '\nInsulin: ' + sbx.roundInsulinForDisplayFormat(lastTreatment.insulin) + 'U' : '')+
      (lastTreatment.enteredBy ? '\nEntered By: ' + lastTreatment.enteredBy : '') +

      //TODO: find a better way to store timeAdjustment
      //(timeAdjustment ? '\nEvent Time: ' + timeAdjustment : '') +

      (lastTreatment.notes ? '\nNotes: ' + lastTreatment.notes : '');


    sbx.notifications.requestNotify({
      level: levels.INFO
      , title: lastTreatment.eventType
      , message: message
      , plugin: treatmentnotify
    });

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