'use strict';

var _ = require('lodash');

function init() {

  function simplealarms() {
    return simplealarms;
  }

  simplealarms.label = 'Simple Alarms';
  simplealarms.pluginType = 'notification';

  simplealarms.checkNotifications = function checkNotifications(sbx) {
    var lastSGV = sbx.data.lastSGV()
      , trigger = false
      , level = 0
      , label = ''
      ;

    if (lastSGV) {
      if (lastSGV > sbx.thresholds.bg_high) {
        trigger = true;
        level = 2;
        label = 'Urgent HIGH:';
        console.info(label + (lastSGV + ' > ' + sbx.thresholds.bg_high));
      } else if (lastSGV > sbx.thresholds.bg_target_top) {
        trigger = true;
        level = 1;
        label = 'High warning:';
        console.info(label + (lastSGV + ' > ' + sbx.thresholds.bg_target_top));
      } else if (lastSGV < sbx.thresholds.bg_low) {
        trigger = true;
        level = 2;
        label = 'Urgent LOW:';
        console.info(label + (lastSGV + ' < ' + sbx.thresholds.bg_low));
      } else if (lastSGV < sbx.thresholds.bg_target_bottom) {
        trigger = true;
        level = 1;
        label = 'Low warning:';
        console.info(label + (lastSGV + ' < ' + sbx.thresholds.bg_target_bottom));
      }

      if (trigger) {
        sbx.notifications.requestNotify({
          level: level
          , display: [label, lastSGV].join(' ')
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