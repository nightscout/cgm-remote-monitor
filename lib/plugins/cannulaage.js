'use strict';

var moment = require('moment');

function init() {

  function cage() {
    return cage;
  }

  cage.label = 'Cannula Age';
  cage.pluginType = 'pill-minor';

  cage.updateVisualisation = function updateVisualisation() {

    var age = 0;
    var found = false;
    var treatmentDate = null;
    var message = '';

    for (var t in this.env.treatments) {
      if (this.env.treatments.hasOwnProperty(t)) {
        var treatment = this.env.treatments[t];

        if (treatment.eventType == "Site Change") {
          treatmentDate = new Date(treatment.created_at);
          var hours = Math.round(Math.abs(new Date() - treatmentDate) / 36e5);

          if (!found) {
            found = true;
            age = hours;
          } else {
            if (hours < age) {
              age = hours;
              if (treatment.notes) { message = treatment.notes; }
            }
          }
        }
      }
    }

    var info = [{label: 'Inserted:', value: moment(treatmentDate).format('lll')}];
    if (message != '') info.push({label: 'Notes:', value: message});

    this.updatePillText(age + 'h', 'CAGE', info);

  };

  return cage();
}


module.exports = init;