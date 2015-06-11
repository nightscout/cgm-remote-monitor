'use strict';

var _ = require('lodash');
var units = require('./units')();

function init(env, ctx) {

  var pushover = require('./pushover')(env);

  // declare local constants for time differences
  var TIME_10_MINS_MS = 10 * 60 * 1000,
    TIME_15_MINS_S = 15 * 60,
    TIME_15_MINS_MS = TIME_15_MINS_S * 1000,
    TIME_30_MINS_MS = TIME_15_MINS_MS * 2;

  var lastSentMBG = null;
  var lastSentTreatment = null;

  //simple SGV Alert throttling
  //TODO: single snooze for websockets and push (when we add push callbacks)
  var lastAlert = 0;
  var lastSGVDate = 0;


  function pushnotify() {
    return pushnotify;
  }

  var lastEmit = {};

  pushnotify.emitNotification = function emitNotification (notify) {
    if (!pushover) return;

    //make this smarter, for now send alerts every 15mins till cleared
    if (lastEmit[notify.level] && lastEmit[notify.level] > Date.now() - TIME_15_MINS_MS) return;

    var msg = {
      expire: TIME_15_MINS_S,
      title: notify.title,
      message: notify.message,
      sound: notify.pushoverSound || 'gamelan',
      timestamp: new Date( ),
      priority: notify.level,
      retry: 30
    };

    pushover.send( msg, function( err, result ) {
      console.info('pushnotify.emitNotification', err, result);
    });

    lastEmit[notify.level] = Date.now();
  };

  pushnotify.process = function process(sbx) {
    if (!pushover) return;
    sendMBG(sbx);
    sendTreatment(sbx)
  };

  function sendTreatment (sbx) {

    var lastTreatment = _.last(ctx.data.treatments);
    if (!lastTreatment) return;

    var ago = new Date().getTime() - new Date(lastTreatment.created_at).getTime();

    if (JSON.stringify(lastTreatment) == JSON.stringify(lastSentTreatment) || ago > TIME_10_MINS_MS) {
      return;
    }

    //since we don't know the time zone on the device viewing the push message
    //we can only show the amount of adjustment
    //TODO: need to store time extra info to figure out if treatment was added in past/future
    //var timeAdjustment = calcTimeAdjustment(eventTime);

    var text = (lastTreatment.glucose ? 'BG: ' + lastTreatment.glucose + ' (' + lastTreatment.glucoseType + ')' : '') +
      (lastTreatment.carbs ? '\nCarbs: ' + lastTreatment.carbs : '') +

      //TODO: find a better way to connect split treatments
      //(preBolusCarbs ? '\nCarbs: ' + preBolusCarbs + ' (in ' + treatment.preBolus + ' minutes)' : '')+

      (lastTreatment.insulin ? '\nInsulin: ' + lastTreatment.insulin : '')+
      (lastTreatment.enteredBy ? '\nEntered By: ' + lastTreatment.enteredBy : '') +

      //TODO: find a better way to store timeAdjustment
      //(timeAdjustment ? '\nEvent Time: ' + timeAdjustment : '') +

      (lastTreatment.notes ? '\nNotes: ' + lastTreatment.notes : '');

    var msg = {
      expire: TIME_15_MINS_S,
      message: text,
      title: lastTreatment.eventType,
      sound: 'gamelan',
      timestamp: new Date( ),
      priority: (lastTreatment.eventType == 'Note' ? -1 : 0),
      retry: 30
    };

    pushover.send( msg, function( err, result ) {
      console.log(result);
    });

    lastSentTreatment = lastTreatment;

  }


  function sendMBG(sbx) {

    var lastMBG = _.last(ctx.data.mbgs);
    if (!lastMBG) return;

    var ago = new Date().getTime() - lastMBG.date;

    if (JSON.stringify(lastMBG) == JSON.stringify(lastSentMBG) || ago > TIME_10_MINS_MS) {
      return;
    }

    var mbg = lastMBG.y;
    if (env.DISPLAY_UNITS == 'mmol') {
      mbg = units.mgdlToMMOL(mbg);
    }
    var msg = {
      expire: TIME_15_MINS_S,
      message: '\nMeter BG: ' + mbg + ' ' + sbx.unitsLabel,
      title: 'Calibration',
      sound: 'magic',
      timestamp: new Date(lastMBG.date),
      priority: 0,
      retry: 30
    };

    pushover.send(msg, function (err, result) {
      console.log(result);
    });

    lastSentMBG = lastMBG;

  }

  //TODO: move some of this to simplealarms
  function old(entry, ctx) {

    if (!entry.sgv || entry.type != 'sgv') {
      return;
    }

    var now = new Date().getTime(),
      offset = new Date().getTime() - entry.date;

    if (offset > TIME_10_MINS_MS || entry.date == lastSGVDate) {
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
      if (sinceLastAlert > TIME_30_MINS_MS) {
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
    } else if (entry.sgv > env.thresholds.bg_target_top && sinceLastAlert > TIME_30_MINS_MS) {
      title = 'High';
      priority = 1;
      sound = 'climb';
    } else if (entry.sgv > env.thresholds.bg_high && sinceLastAlert > TIME_30_MINS_MS) {
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

      pushover.send(msg, function (err, result) {
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