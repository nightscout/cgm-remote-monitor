'use strict';

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
      , trigger = false
      , level = 0
      , title = ''
      , pushoverSound = null
      ;

    var eventName = '';

    if (scaledSGV && lastSGVEntry && lastSGVEntry.mgdl > 39 && Date.now() - lastSGVEntry.mills < TIME_10_MINS_MS) {
      if (scaledSGV > sbx.scaleMgdl(sbx.thresholds.bg_high)) {
        trigger = true;
        level = 2;
        title = 'Urgent HIGH';
        pushoverSound = 'persistent';
        eventName = 'high';
      } else if (scaledSGV > sbx.scaleMgdl(sbx.thresholds.bg_target_top)) {
        trigger = true;
        level = 1;
        title = 'High warning';
        pushoverSound = 'climb';
        eventName = 'high';
      } else if (scaledSGV < sbx.scaleMgdl(sbx.thresholds.bg_low)) {
        trigger = true;
        level = 2;
        title = 'Urgent LOW';
        pushoverSound = 'persistent';
        eventName = 'low';
      } else if (scaledSGV < sbx.scaleMgdl(sbx.thresholds.bg_target_bottom)) {
        trigger = true;
        level = 1;
        title = 'Low warning';
        pushoverSound = 'falling';
        eventName = 'low';
        console.info(title + ': ' + (scaledSGV + ' < ' + sbx.scaleMgdl(sbx.thresholds.bg_target_bottom)));
      }

      if (trigger) {
        sbx.notifications.requestNotify({
          level: level
          , title: title
          , message: sbx.buildDefaultMessage()
          , eventName: eventName
          , plugin: simplealarms
          , pushoverSound: pushoverSound
          , debug: {
            lastSGV: scaledSGV, thresholds: sbx.thresholds
          }
        });
      }
    }
  };

  return simplealarms;

}

module.exports = init;