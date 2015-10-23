/* jshint node: true */
'use strict';

var _ = require('lodash');

function init() {

  var pumpiob = {
    name: 'pumpiob'
    , label: 'Pump IOB'
    , pluginType: 'pill-major'
  };

  pumpiob.setProperties = function setProperties(sbx) {
    sbx.offerProperty('pumpiob', function setPumpIOB () {
      return pumpiob.getPumpIOB(
        sbx.data,
        sbx.withExtendedSettings(pumpiob).extendedSettings,
        sbx.time
      );
    });
  };

  pumpiob.getPumpIOB = function getPumpIOB (data, settings, time) {
    settings = _.merge(
      {}
      , {
          recency: 10
          // this is the MiniMed Connect's threshold for LOW vs MEDIUM
          , pebbleBatteryIndicator: 25
        }
      , settings
    );
    settings.recency = parseInt(settings.recency, 10);
    settings.pebbleBatteryIndicator = parseInt(settings.pebbleBatteryIndicator, 10);

    var lastPumpStatus = _.last(data.pumpStatuses);

    if (!lastPumpStatus || lastPumpStatus.activeInsulin === undefined) {
      return null;
    } else if (time - lastPumpStatus.mills > settings.recency * 60 * 1000) {
      return null;
    } else {
      var display = lastPumpStatus.activeInsulin.toFixed(1);

      var pebbleDisplay = display;
      if (settings.pebbleBatteryIndicator && lastPumpStatus.conduitBatteryLevel <= settings.pebbleBatteryIndicator) {
        pebbleDisplay += '*';
      }

      return {
        display: display
        , displayLine: 'IOB: ' + display + 'U'
        , pebbleDisplay: pebbleDisplay
        , uploaderBattery: lastPumpStatus.conduitBatteryLevel
      };
    }
  };

  pumpiob.updateVisualisation = function updateVisualisation(sbx) {
    var prop = sbx.properties.pumpiob;

    var info;
    if (prop && prop.uploaderBattery) {
      info = [{label: 'Uploader Battery', value: prop.uploaderBattery}];
    }

    sbx.pluginBase.updatePillText(pumpiob, {
      value: prop.display + 'U'
      , label: 'IOB'
      , info: info
    });
  };

  return pumpiob;

}

module.exports = init;
