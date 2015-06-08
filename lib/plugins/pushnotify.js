'use strict';

var units = require('../units')();

function init() {

  // declare local constants for time differences
  var TIME_10_MINS = 10 * 60 * 1000,
    TIME_15_MINS = 15 * 60 * 1000,
    TIME_30_MINS = TIME_15_MINS * 2;

  //the uploader may the last MBG multiple times, make sure we get a single notification
  var lastMBGDate = 0;

  //simple SGV Alert throttling
  //TODO: single snooze for websockets and push (when we add push callbacks)
  var lastAlert = 0;
  var lastSGVDate = 0;


  function pushnotify() {
    return pushnotify;
  }

  pushnotify.label = 'Push Notify';
  pushnotify.pluginType = 'server-process';

  pushnotify.processEntry = function processEntry(entry, ctx, env) {
    if (entry.type && entry.date && ctx.pushover) {
      if (entry.type == 'mbg' || entry.type == 'meter') {
        sendMBGPushover(entry, ctx);
      } else if (entry.type == 'sgv') {
        sendSGVPushover(entry, ctx);
      }
    }
  };

  pushnotify.processTreatment = function processTreatment(treatment, eventTime, preBolusCarbs, ctx, env) {

    if (!ctx.pushover) return;

    //since we don't know the time zone on the device viewing the push message
    //we can only show the amount of adjustment
    var timeAdjustment = calcTimeAdjustment(eventTime);

    var text = (treatment.glucose ? 'BG: ' + treatment.glucose + ' (' + treatment.glucoseType + ')' : '') +
      (treatment.carbs ? '\nCarbs: ' + treatment.carbs : '') +
      (preBolusCarbs ? '\nCarbs: ' + preBolusCarbs + ' (in ' + treatment.preBolus + ' minutes)' : '')+
      (treatment.insulin ? '\nInsulin: ' + treatment.insulin : '')+
      (treatment.enteredBy ? '\nEntered By: ' + treatment.enteredBy : '') +
      (timeAdjustment ? '\nEvent Time: ' + timeAdjustment : '') +
      (treatment.notes ? '\nNotes: ' + treatment.notes : '');

    var msg = {
      expire: 14400, // 4 hours
      message: text,
      title: treatment.eventType,
      sound: 'gamelan',
      timestamp: new Date( ),
      priority: (treatment.eventType == 'Note' ? -1 : 0),
      retry: 30
    };

    ctx.pushover.send( msg, function( err, result ) {
      console.log(result);
    });

  };


  function sendMBGPushover(entry, ctx) {

    if (entry.mbg && entry.type == 'mbg' && entry.date != lastMBGDate) {
      var offset = new Date().getTime() - entry.date;
      if (offset > TIME_10_MINS) {
        console.info('No MBG Pushover, offset: ' + offset + ' too big, doc.date: ' + entry.date + ', now: ' + new Date().getTime());
      } else {
        var mbg = entry.mbg;
        if (env.DISPLAY_UNITS == 'mmol') {
          mbg = units.mgdlToMMOL(mbg);
        }
        var msg = {
          expire: 14400, // 4 hours
          message: '\nMeter BG: ' + mbg,
          title: 'Calibration',
          sound: 'magic',
          timestamp: new Date(entry.date),
          priority: 0,
          retry: 30
        };

        ctx.pushover.send(msg, function (err, result) {
          console.log(result);
        });
      }
      lastMBGDate = entry.date;
    }
  }

  function sendSGVPushover(entry, ctx) {

    if (!entry.sgv || entry.type != 'sgv') {
      return;
    }

    var now = new Date().getTime(),
      offset = new Date().getTime() - entry.date;

    if (offset > TIME_10_MINS || entry.date == lastSGVDate) {
      console.info('No SVG Pushover, offset: ' + offset + ' too big, doc.date: ' + entry.date + ', now: ' + new Date().getTime() + ', lastSGVDate: ' + lastSGVDate);
      return;
    }

    // initialize message data
    var sinceLastAlert = now - lastAlert,
      title = 'CGM Alert',
      priority = 0,
      sound = null,
      readingtime = entry.date,
      readago = now - readingtime;

    console.info('now: ' + now);
    console.info('doc.sgv: ' + entry.sgv);
    console.info('doc.direction: ' + entry.direction);
    console.info('doc.date: ' + entry.date);
    console.info('readingtime: ' + readingtime);
    console.info('readago: ' + readago);

    // set vibration pattern; alert value; 0 nothing, 1 normal, 2 low, 3 high
    if (entry.sgv < 39) {
      if (sinceLastAlert > TIME_30_MINS) {
        title = 'CGM Error';
        priority = 1;
        sound = 'persistent';
      }
    } else if (entry.sgv < env.thresholds.bg_low && sinceLastAlert > TIME_15_MINS) {
      title = 'Urgent Low';
      priority = 2;
      sound = 'persistent';
    } else if (entry.sgv < env.thresholds.bg_target_bottom && sinceLastAlert > TIME_15_MINS) {
      title = 'Low';
      priority = 1;
      sound = 'falling';
    } else if (entry.sgv < 120 && entry.direction == 'DoubleDown') {
      title = 'Double Down';
      priority = 1;
      sound = 'falling';
    } else if (entry.sgv == 100 && entry.direction == 'Flat' && sinceLastAlert > TIME_15_MINS) { //Perfect Score - a good time to take a picture :)
      title = 'Perfect';
      priority = 0;
      sound = 'cashregister';
    } else if (entry.sgv > 120 && entry.direction == 'DoubleUp' && sinceLastAlert > TIME_15_MINS) {
      title = 'Double Up';
      priority = 1;
      sound = 'climb';
    } else if (entry.sgv > env.thresholds.bg_target_top && sinceLastAlert > TIME_30_MINS) {
      title = 'High';
      priority = 1;
      sound = 'climb';
    } else if (entry.sgv > env.thresholds.bg_high && sinceLastAlert > TIME_30_MINS) {
      title = 'Urgent High';
      priority = 1;
      sound = 'persistent';
    }

    if (sound != null) {
      lastAlert = now;

      var msg = {
        expire: 14400, // 4 hours
        message: 'BG NOW: ' + entry.sgv,
        title: title,
        sound: sound,
        timestamp: new Date(entry.date),
        priority: priority,
        retry: 30
      };

      ctx.pushover.send(msg, function (err, result) {
        console.log(result);
      });
    }


    lastSGVDate = entry.date;
  }

  function calcTimeAdjustment(eventTime) {

    if (!eventTime) return null;

    var now = (new Date()).getTime(),
      other = eventTime.getTime(),
      past = other < now,
      offset = Math.abs(now - other);

    var MINUTE = 60 * 1000,
      HOUR = 3600 * 1000;

    var parts = {};

    if (offset <= MINUTE)
      return 'now';
    else if (offset < (HOUR * 2))
      parts = { value: Math.round(Math.abs(offset / MINUTE)), label: 'mins' };
    else
      parts = { value: Math.round(Math.abs(offset / HOUR)), label: 'hrs' };

    if (past)
      return parts.value + ' ' + parts.label + ' ago';
    else
      return 'in ' + parts.value + ' ' + parts.label;
  }

  return pushnotify();
}


module.exports = init;