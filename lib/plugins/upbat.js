'use strict';

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

      var battery = sbx.data.uploaderBattery;

      if (battery) {
        result.value = battery;
        result.display = battery + '%';

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
      , hide: !(prop && prop.value && prop.value >= 0)
    });
  };

  return upbat;

}

module.exports = init;