'use strict';

var _ = require('lodash');

function init() {

  var TIME_10_MINS_MS = 10 * 60 * 1000;

  function treatmentnotify() {
    return treatmentnotify;
  }

  treatmentnotify.label = 'Treatment Notifications';
  treatmentnotify.pluginType = 'notification';

  treatmentnotify.checkNotifications = function checkNotifications (sbx) {

    var now = Date.now();

    var lastMBG = _.last(sbx.data.mbgs);
    var lastTreatment = _.last(sbx.data.treatments);

    //TODO: figure out why date is x here #CleanUpDataModel
    var mbgAgo = (lastMBG && lastMBG.x < now) ? now - lastMBG.x : 0;
    var mbgCurrent = mbgAgo != 0 && mbgAgo < TIME_10_MINS_MS;

    var lastTreatmentTime = lastTreatment ? new Date(lastTreatment.created_at).getTime() : 0;
    var treatmentAgo = (lastTreatmentTime && lastTreatmentTime < now) ? now - lastTreatmentTime : 0;
    var treatmentCurrent = treatmentAgo != 0 && treatmentAgo < TIME_10_MINS_MS;

    if (mbgCurrent || treatmentCurrent) {
      //first auto snooze any alarms
      sbx.notifications.requestSnooze({
        level: sbx.notifications.levels.URGENT
        , mills: TIME_10_MINS_MS
        //, debug: results
      });

      //and add some info notifications
      //the notification providers (push, websockets, etc) are responsible to not sending the same notifications repeatedly
      if (mbgCurrent) requestMBGNotify(lastMBG, sbx);
      if (treatmentCurrent) requestTreatmentNotify(lastTreatment, sbx);
    }
  };

  function requestMBGNotify (lastMBG, sbx) {
    sbx.notifications.requestNotify({
      level: sbx.notifications.levels.INFO
      , title: 'Calibration'
      //TODO: figure out why mbg is y here #CleanUpDataModel
      , message: '\nMeter BG: ' + sbx.scaleBg(lastMBG.y) + ' ' + sbx.unitsLabel
      , pushoverSound: 'magic'
      //, debug: results
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
      level: sbx.notifications.levels.INFO
      , title: lastTreatment.eventType
      , message: message
//      , debug: results
    });

  }

  return treatmentnotify();

}

module.exports = init;