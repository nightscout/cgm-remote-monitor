'use strict';

var times = require('../times');

function init(ctx) {

  var simplealarms = {
    name: 'simplealarms'
    , label: 'Simple Alarms'
    , pluginType: 'notification'
  };
  
  var levels = ctx.levels;

  simplealarms.checkNotifications = function checkNotifications(sbx) {

    var lastSGVEntry = sbx.lastSGVEntry()
      , scaledSGV = sbx.scaleEntry(lastSGVEntry)
      ;

    if (scaledSGV && lastSGVEntry && lastSGVEntry.mgdl > 39 && sbx.time - lastSGVEntry.mills < times.mins(10).msecs) {
      var result = simplealarms.compareBGToTresholds(scaledSGV, sbx);
      if (levels.isAlarm(result.level)) {
        sbx.notifications.requestNotify({
          level: result.level
          , title: result.title
          , message: sbx.buildDefaultMessage()
          , eventName: result.eventName
          , plugin: simplealarms
          , pushoverSound: result.pushoverSound
          , debug: {
            lastSGV: scaledSGV, thresholds: sbx.settings.thresholds
          }
        });
      }
    }
  };

  simplealarms.compareBGToTresholds = function compareBGToTresholds(scaledSGV, sbx) {
    var result = { level: levels.INFO };

    if (sbx.settings.alarmUrgentHigh && scaledSGV > sbx.scaleMgdl(sbx.settings.thresholds.bgHigh)) {
      result.level = levels.URGENT;
      result.title = levels.toDisplay(levels.URGENT) + ' HIGH';
      result.pushoverSound = 'persistent';
      result.eventName = 'high';
    } else
      if (sbx.settings.alarmHigh && scaledSGV > sbx.scaleMgdl(sbx.settings.thresholds.bgTargetTop)) {
        result.level = levels.WARN;
        result.title = levels.toDisplay(levels.WARN) + ' HIGH';
        result.pushoverSound = 'climb';
        result.eventName = 'high';
      }

    if (sbx.settings.alarmUrgentLow && scaledSGV < sbx.scaleMgdl(sbx.settings.thresholds.bgLow)) {
      result.level = levels.URGENT;
      result.title = levels.toDisplay(levels.URGENT) + ' LOW';
      result.pushoverSound = 'persistent';
      result.eventName = 'low';
    } else if (sbx.settings.alarmLow && scaledSGV < sbx.scaleMgdl(sbx.settings.thresholds.bgTargetBottom)) {
      result.level = levels.WARN;
      result.title = levels.toDisplay(levels.WARN) + ' LOW';
      result.pushoverSound = 'falling';
      result.eventName = 'low';
    }

    return result;
  };

  return simplealarms;

}

module.exports = init;