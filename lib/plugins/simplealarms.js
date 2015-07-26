'use strict';

var levels = require('../levels');

function init() {

  var simplealarms = {
    name: 'simplealarms'
    , label: 'Simple Alarms'
    , pluginType: 'notification'
  };

  var TIME_10_MINS_MS = 10 * 60 * 1000;

  simplealarms.checkNotifications = function checkNotifications(sbx) {
    var lastSGVEntry = sbx.lastSGVEntry()
      , scaledSGV = sbx.scaleEntry(lastSGVEntry)
      ;

    if (scaledSGV && lastSGVEntry && lastSGVEntry.mgdl > 39 && Date.now() - lastSGVEntry.mills < TIME_10_MINS_MS) {
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
            lastSGV: scaledSGV, thresholds: sbx.thresholds
          }
        });
      }
    }
  };

  simplealarms.compareBGToTresholds = function compareBGToTresholds(scaledSGV, sbx) {
    var result = { level: levels.INFO };

    if (scaledSGV > sbx.scaleMgdl(sbx.thresholds.bg_high)) {
      result.level = levels.URGENT;
      result.title = levels.toDisplay(levels.URGENT) + ' HIGH';
      result.pushoverSound = 'persistent';
      result.eventName = 'high';
    } else if (scaledSGV > sbx.scaleMgdl(sbx.thresholds.bg_target_top)) {
      result.level = levels.WARN;
      result.title = levels.toDisplay(levels.WARN) + ' HIGH';
      result.pushoverSound = 'climb';
      result.eventName = 'high';
    } else if (scaledSGV < sbx.scaleMgdl(sbx.thresholds.bg_low)) {
      result.level = levels.URGENT;
      result.title = levels.toDisplay(levels.URGENT) + ' LOW';
      result.pushoverSound = 'persistent';
      result.eventName = 'low';
    } else if (scaledSGV < sbx.scaleMgdl(sbx.thresholds.bg_target_bottom)) {
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