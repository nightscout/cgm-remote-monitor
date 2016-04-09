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
  function filterTreatments(sbx) {
    var treatments = sbx.data.treatments;

    treatments = _.filter(treatments, function notOpenAPS(treatment) {
      var ok = true;
      if (treatment.enteredBy && treatment.enteredBy.indexOf('openaps://') === 0) {
        ok = _.indexOf(OPENAPS_WHITELIST, treatment.eventType) >= 0;
      }
      return ok;
    });

    return treatments;
  }

  treatmentnotify.checkNotifications = function checkNotifications(sbx) {

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
      if (mbgCurrent) {
        requestMBGNotify(lastMBG, sbx);
      }
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

  function requestMBGNotify(lastMBG, sbx) {
    console.info('requestMBGNotify for', lastMBG);
    sbx.notifications.requestNotify({
      level: levels.INFO
      , title: 'Calibration' //assume all MGBs are calibrations for now
      , message: 'Meter BG: ' + sbx.scaleEntry(lastMBG) + ' ' + sbx.unitsLabel
      , plugin: treatmentnotify
      , pushoverSound: 'magic'
    });
  }

  function requestAnnouncementNotify(lastTreatment, sbx) {
    var result = simplealarms.compareBGToTresholds(sbx.scaleMgdl(lastTreatment.mgdl), sbx);

    sbx.notifications.requestNotify({
      level: result.level
      , title: (result.level === levels.URGENT ? levels.toDisplay(levels.URGENT) + ' ' : '') + lastTreatment.eventType
      , message: lastTreatment.notes || '.' //some message is required
      , plugin: treatmentnotify
      , pushoverSound: levels.isAlarm(result.level) ? result.pushoverSound : undefined
      , isAnnouncement: true
    });
  }

  function requestTreatmentNotify(lastTreatment, sbx) {
    if (lastTreatment.isAnnouncement) {
      requestAnnouncementNotify(lastTreatment, sbx);
    } else {
      var message = buildTreatmentMessage(lastTreatment, sbx);

      sbx.notifications.requestNotify({
        level: levels.INFO
        , title: lastTreatment.eventType
        , message: message
        , plugin: treatmentnotify
      });
    }
  }

  var pluginStrings = {
    glucose: function buildGlucoseMessage(glucose, glucoseType) {
      return glucose ? 'BG: ' + glucose + ' (' + glucoseType + ')' : '';
    }
    , carbs: function buildCarbsMessage(carbs) {
      return carbs ? '\nCarbs: ' + carbs + 'g' : '';
    }
    , insulin: function buildInsulinMessage(insulin, sbx) {
      return insulin ? '\nInsulin: ' + sbx.roundInsulinForDisplayFormat(insulin) + 'U' : '';
    }
    , duration: function buildDurationMessage(duration) {
      return duration ? '\nDuration: ' + duration + ' min' : '';
    }
    , percent: function buildPercentMessage(percent) {
      return percent ? '\nPercent: ' + (percent > 0 ? '+' : '') + percent + '%' : '';
    }
    , absolute: function buildAbsoluteMessage(absolute) {
      return !isNaN(absolute) ? '\nValue: ' + absolute + 'U' : '';
    }
    , enteredBy: function buildEnteredByMessage(enteredBy) {
      return enteredBy ? '\nEntered By: ' + enteredBy : '';
    }
    , notes: function buildNotesMessage(notes) {
      return notes ? '\nNotes: ' + notes : '';
    }
  }

  function buildTreatmentMessage(lastTreatment, sbx) {
    return pluginStrings.glucose(lastTreatment.glucose, lastTreatment.glucoseType) +
           pluginStrings.carbs(lastTreatment.carbs) +
           pluginStrings.insulin(lastTreatment.insulin, sbx) +
           pluginStrings.duration(lastTreatment.duration) +
           pluginStrings.percent(lastTreatment.percent) +
           pluginStrings.absolute(lastTreatment.absolute) +
           pluginStrings.enteredBy(lastTreatment.enteredBy) +
           pluginStrings.notes(lastTreatment.notes);
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