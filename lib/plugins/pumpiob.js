/* jshint node: true */
'use strict';

var _ = require('lodash');

// Pump IOB mixin for the iob plugin
function init(plugin) {
  var pumpiob = {};

  pumpiob.setProperties = function setProperties (sbx) {
    sbx.offerProperty(plugin.name, function setIOB () {
      return pumpiob.getPumpIOB(sbx.data.pumpStatuses, sbx.extendedSettings, sbx.time);
    });
  };

  pumpiob.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.iob
      , info
      , value;

    if (prop) {
      value = prop.display + 'U';
      if (prop.uploaderBattery) {
        info = [{label: 'Uploader Battery', value: prop.uploaderBattery + '%'}];
      }
    } else {
      value = '---';
      info = [{label: 'Pump IOB', value: 'No recent data'}];
    }

    sbx.pluginBase.updatePillText(plugin, {
      label: 'IOB'
      , value: value
      , info: info
    });
  };

  pumpiob.getPumpIOB = function getPumpIOB (pumpStatuses, settings, time) {
    settings = _.cloneDeep(settings);
    settings.pumpRecency = settings.pumpRecency !== undefined ? parseInt(settings.pumpRecency, 10) : 10;
    // 25 is the MiniMed Connect's threshold for LOW vs MEDIUM
    settings.pumpBatteryPebble = settings.pumpBatteryPebble !== undefined ? parseInt(settings.pumpBatteryPebble, 10) : 25;

    var lastPumpStatus = _.last(_.dropRightWhile(pumpStatuses, function (pumpStatus) {
      return pumpStatus.mills > time;
    }));

    if (!lastPumpStatus || lastPumpStatus.activeInsulin === undefined) {
      return null;
    } else if (time - lastPumpStatus.mills > settings.pumpRecency * 60 * 1000) {
      return null;
    } else {
      var iob = lastPumpStatus.activeInsulin;
      var display = iob.toFixed(1);

      var pebbleDisplay = display;
      if (settings.pumpBatteryPebble && lastPumpStatus.conduitBatteryLevel <= settings.pumpBatteryPebble) {
        pebbleDisplay += '*';
      }

      return {
        iob: iob
        , display: display
        , displayLine: 'IOB: ' + display + 'U'
        , pebbleDisplay: pebbleDisplay
        , uploaderBattery: lastPumpStatus.conduitBatteryLevel
      };
    }
  };

  return pumpiob;
}

module.exports = init;
