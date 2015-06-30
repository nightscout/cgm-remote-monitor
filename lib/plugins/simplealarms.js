'use strict';

var _ = require('lodash');

function init() {

  function simplealarms() {
    return simplealarms;
  }

  var TIME_10_MINS_MS = 10 * 60 * 1000;

  simplealarms.label = 'Simple Alarms';
  simplealarms.pluginType = 'notification';

  simplealarms.checkNotifications = function checkNotifications(sbx) {
    var lastSGV = sbx.scaleBg(sbx.data.lastSGV())
      , lastSGVEntry = _.last(sbx.data.sgvs)
      , trigger = false
      , level = 0
      , title = ''
      , pushoverSound = null
      ;

    if (lastSGV && lastSGVEntry && lastSGVEntry.y > 39 && Date.now() - lastSGVEntry.x < TIME_10_MINS_MS) {
      if (lastSGV > sbx.scaleBg(sbx.thresholds.bg_high)) {
        trigger = true;
        level = 2;
        title = 'Urgent HIGH';
        pushoverSound = 'persistent';
        console.info(title + ': ' + (lastSGV + ' > ' + sbx.scaleBg(sbx.thresholds.bg_high)));
      } else if (lastSGV > sbx.scaleBg(sbx.thresholds.bg_target_top)) {
        trigger = true;
        level = 1;
        title = 'High warning';
        pushoverSound = 'climb';
        console.info(title + ': ' + (lastSGV + ' > ' + sbx.scaleBg(sbx.thresholds.bg_target_top)));
      } else if (lastSGV < sbx.scaleBg(sbx.thresholds.bg_low)) {
        trigger = true;
        level = 2;
        title = 'Urgent LOW';
        pushoverSound = 'persistent';
        console.info(title + ': ' + (lastSGV + ' < ' + sbx.scaleBg(sbx.thresholds.bg_low)));
      } else if (lastSGV < sbx.scaleBg(sbx.thresholds.bg_target_bottom)) {
        trigger = true;
        level = 1;
        title = 'Low warning';
        pushoverSound = 'falling';
        console.info(title + ': ' + (lastSGV + ' < ' + sbx.scaleBg(sbx.thresholds.bg_target_bottom)));
      }

      var message = 'BG Now: ' + lastSGV;

      var delta = sbx.properties.delta && sbx.properties.delta.display;
      if (delta) {
        message += ' ' + delta;
      }
      message += ' ' + sbx.unitsLabel;

      if (trigger) {
        sbx.notifications.requestNotify({
          level: level
          , title: title
          , message: message
          , plugin: simplealarms
          , pushoverSound: pushoverSound
          , debug: {
            lastSGV: lastSGV, thresholds: sbx.thresholds
          }
        });
      }
    }
  };

  return simplealarms();

}

module.exports = init;