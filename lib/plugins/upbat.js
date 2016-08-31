'use strict';

var _ = require('lodash');

function init() {

  var upbat = {
    name: 'upbat'
    , label: 'Uploader Battery'
    , pluginType: 'pill-status'
    , pillFlip: true
  };

  upbat.setProperties = function setProperties (sbx) {
    sbx.offerProperty('upbat', function setUpbat ( ) {

      var result = { display: null };

      var uploaderStatus = _.findLast(sbx.data.devicestatus, function (status) {
        return sbx.entryMills(status) <= sbx.time && ('uploader' in status);
      });

      var battery, voltage, voltageDisplay;

      if (uploaderStatus && uploaderStatus.uploader) {
        battery = uploaderStatus.uploader.battery;
        voltage = uploaderStatus.uploader.batteryVoltage;
      }

      if (voltage) {
        if (voltage > 1000) {
          voltage = voltage / 1000;
        }
        voltageDisplay = voltage.toFixed(3) + 'v';
      }

      if (battery || voltage) {
        result.value = battery || voltage;
        result.battery = battery;
        result.voltage = voltage;
        result.voltageDisplay = voltageDisplay;
        result.display = battery ? battery + '%' : voltageDisplay;

        if (battery >= 95) {
          result.level = 100;
        } else if (battery < 95 && battery >= 55) {
          result.level = 75;
        } else if (battery < 55 && battery >= 30) {
          result.level = 50;
        } else {
          result.level = 25;
        }

        if (battery <= 30 && battery > 20) {
          result.status = 'warn';
        } else if (battery <= 20) {
          result.status = 'urgent';
        } else {
          result.status = null;
        }
      }

      return result;
    });
  };

  upbat.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.upbat;

    sbx.pluginBase.updatePillText(upbat, {
      value: prop && prop.display
      , labelClass: prop && prop.level && 'icon-battery-' + prop.level
      , pillClass: prop && prop.status
      , info: prop.battery && prop.voltageDisplay ? [{label: 'Voltage', value: prop.voltageDisplay}] : null
      , hide: !(prop && prop.value && prop.value >= 0)
    });
  };

  return upbat;

}

module.exports = init;