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
      , displaySGV = sbx.displayBg(sbx.data.lastSGV())
      , lastSGVEntry = _.last(sbx.data.sgvs)
      , trigger = false
      , level = 0
      , title = ''
      , pushoverSound = null
      ;

    var eventName = '';

    if (lastSGV && lastSGVEntry && lastSGVEntry.y > 39 && Date.now() - lastSGVEntry.x < TIME_10_MINS_MS) {
      if (lastSGV > sbx.scaleBg(sbx.thresholds.bg_high)) {
        trigger = true;
        level = 2;
        title = 'Urgent HIGH';
        pushoverSound = 'persistent';
        eventName = 'high';
        console.info(title + ': ' + (lastSGV + ' > ' + sbx.scaleBg(sbx.thresholds.bg_high)));
      } else if (lastSGV > sbx.scaleBg(sbx.thresholds.bg_target_top)) {
        trigger = true;
        level = 1;
        title = 'High warning';
        pushoverSound = 'climb';
        eventName = 'high';
        console.info(title + ': ' + (lastSGV + ' > ' + sbx.scaleBg(sbx.thresholds.bg_target_top)));
      } else if (lastSGV < sbx.scaleBg(sbx.thresholds.bg_low)) {
        trigger = true;
        level = 2;
        title = 'Urgent LOW';
        pushoverSound = 'persistent';
        eventName = 'low';
        console.info(title + ': ' + (lastSGV + ' < ' + sbx.scaleBg(sbx.thresholds.bg_low)));
      } else if (lastSGV < sbx.scaleBg(sbx.thresholds.bg_target_bottom)) {
        trigger = true;
        level = 1;
        title = 'Low warning';
        pushoverSound = 'falling';
        eventName = 'low';
        console.info(title + ': ' + (lastSGV + ' < ' + sbx.scaleBg(sbx.thresholds.bg_target_bottom)));
      }

      var lines = ['BG Now: ' + displaySGV];

      var delta = sbx.properties.delta && sbx.properties.delta.display;
      if (delta) {
        lines[0] += ' ' + delta;
      }
      lines[0] += ' ' + sbx.unitsLabel;

      var rawbgProp = sbx.properties.rawbg;
      if (rawbgProp) {
        lines.push(['Raw BG:', sbx.scaleBg(rawbgProp.value), sbx.unitsLabel, rawbgProp.noiseLabel].join(' '));
      }

      var bwp = sbx.properties.bwp && sbx.properties.bwp.bolusEstimateDisplay;
      if (bwp && bwp > 0) {
        lines.push(['BWP:', bwp, 'U'].join(' '));
      }

      var iob = sbx.properties.iob && sbx.properties.iob.display;
      if (iob) {
        lines.push(['IOB:', iob, 'U'].join(' '));
      }

      var cob = sbx.properties.cob && sbx.properties.cob.display;
      if (cob) {
        lines.push(['COB:', cob, 'g'].join(' '));
      }

      var message = lines.join('\n');

      if (trigger) {
        sbx.notifications.requestNotify({
          level: level
          , title: title
          , message: message
          , eventName: eventName
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