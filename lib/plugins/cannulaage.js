'use strict';

var _ = require('lodash');
var moment = require('moment');

function init() {

  function cage() {
    return cage;
  }

  cage.label = 'Cannula Age';
  cage.pluginType = 'pill-minor';

  cage.updateVisualisation = function updateVisualisation (sbx) {
    var age = 0;
    var found = false;
    var treatmentDate = null;
    var message = '';

    _.forEach(sbx.data.treatments, function eachTreatment (treatment) {
      if (treatment.eventType === 'Site Change') {
        treatmentDate = new Date(treatment.created_at);
        var hours = Math.round(Math.abs(sbx.time - treatmentDate) / 36e5);

        if (!found) {
          found = true;
          age = hours;
        } else {
          if (hours < age) {
            age = hours;
            if (treatment.notes) {
              message = treatment.notes;
            }
          }
        }
      }
    });

    var info = [{label: 'Inserted:', value: moment(treatmentDate).format('lll')}];
    if (message !== '') { info.push({label: 'Notes:', value: message}); }

    sbx.pluginBase.updatePillText(cage, {
      value: age + 'h'
      , label: 'CAGE'
      , info: info
    });

  };

  return cage();
}


module.exports = init;