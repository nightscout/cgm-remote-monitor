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
      , label = ''
      , pushoverSound = null
      ;

    if (lastSGV) {
      if (lastSGV > sbx.thresholds.bg_high) {
        trigger = true;
        level = 2;
        label = 'Urgent HIGH:';
        pushoverSound = 'persistent';
        console.info(label + (lastSGV + ' > ' + sbx.thresholds.bg_high));
      } else if (lastSGV > sbx.thresholds.bg_target_top) {
        trigger = true;
        level = 1;
        label = 'High warning:';
        pushoverSound = 'climb';
        console.info(label + (lastSGV + ' > ' + sbx.thresholds.bg_target_top));
      } else if (lastSGV < sbx.thresholds.bg_low) {
        trigger = true;
        level = 2;
        label = 'Urgent LOW:';
        pushoverSound = 'persistent';
        console.info(label + (lastSGV + ' < ' + sbx.thresholds.bg_low));
      } else if (lastSGV < sbx.thresholds.bg_target_bottom) {
        trigger = true;
        level = 1;
        label = 'Low warning:';
        pushoverSound = 'falling';
        console.info(label + (lastSGV + ' < ' + sbx.thresholds.bg_target_bottom));
      } else if (sbx.thresholds.bg_magic && lastSVG == sbx.thresholds.bg_magic && lastSGVEntry.direction == 'Flat') {
        trigger = true;
        level = o;
        label = 'Perfect:';
        pushoverSound = 'magic';
      }



      if (trigger) {
        sbx.notifications.requestNotify({
          level: level
          , display: [label, lastSGV].join(' ')
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