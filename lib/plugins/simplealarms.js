'use strict';

var _ = require('lodash');

function init() {

  function simplealarms() {
    return simplealarms;
  }

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

    if (lastSGV) {
      if (lastSGV > sbx.scaleBg(sbx.thresholds.bg_high)) {
        trigger = true;
        level = 2;
        title = 'Urgent HIGH';
        pushoverSound = 'persistent';
        console.info(title + ': ' + (lastSGV + ' > ' + sbx.scaleBg(sbx.thresholds.bg_high)));
      } else if (lastSGV > sbx.thresholds.bg_target_top) {
        trigger = true;
        level = 1;
        title = 'High warning';
        pushoverSound = 'climb';
        console.info(title + ': ' + (lastSGV + ' > ' + sbx.scaleBg(sbx.thresholds.bg_target_top)));
      } else if (lastSGV < sbx.thresholds.bg_low) {
        trigger = true;
        level = 2;
        title = 'Urgent LOW';
        pushoverSound = 'persistent';
        console.info(title + ': ' + (lastSGV + ' < ' + sbx.scaleBg(sbx.thresholds.bg_low)));
      } else if (lastSGV < sbx.thresholds.bg_target_bottom) {
        trigger = true;
        level = 1;
        title = 'Low warning';
        pushoverSound = 'falling';
        console.info(title + ': ' + (lastSGV + ' < ' + sbx.scaleBg(sbx.thresholds.bg_target_bottom)));
      } else if (sbx.thresholds.bg_magic && lastSVG == sbx.thresholds.bg_magic && lastSGVEntry.direction == 'Flat') {
        trigger = true;
        level = o;
        title = 'Perfect';
        pushoverSound = 'magic';
      }



      if (trigger) {
        sbx.notifications.requestNotify({
          level: level
          , title: title
          , message: [lastSGV, sbx.unitsLabel].join(' ')
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