'use strict';

function buildDefaultProfile () {
  return {
    dia: 3,
    carbratio: [{ time: '00:00', value: 30 }],
    carbs_hr: 20,
    delay: 20,
    sens: [{ time: '00:00', value: 100 }],
    timezone: 'UTC',

    perGIvalues: false,
    carbs_hr_high: 30,
    carbs_hr_medium: 30,
    carbs_hr_low: 30,
    delay_high: 15,
    delay_medium: 20,
    delay_low: 20,

    basal: [{ time: '00:00', value: 0.1 }],
    target_low: [{ time: '00:00', value: 0 }],
    target_high: [{ time: '00:00', value: 0 }],
    startDate: new Date(0).toISOString()
  };
}

module.exports = buildDefaultProfile;
module.exports.buildDefaultProfile = buildDefaultProfile;
