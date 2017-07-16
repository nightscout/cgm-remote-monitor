'use strict';

function init() {

  var careportal = {
    name: 'careportal'
    , label: 'Care Portal'
    , pluginType: 'drawer'
  };

  careportal.getEventTypes = function getEventTypes (sbx) {

    //TODO: use sbx and new CAREPORTAL_EVENTTYPE_GROUPS="core temps combo dad sensor site etc"

    return [
      { val: '<none>'
        , name: '<none>'
        , bg: true,  insulin: true,  carbs: true,  prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false
      }
      , { val: 'BG Check'
        , name: 'BG Check'
        , bg: true,  insulin: false, carbs: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false
      }
      , { val: 'Snack Bolus'
        , name: 'Snack Bolus'
        , bg: true,  insulin: true,  carbs: true,  prebolus: true,  duration: false, percent: false, absolute: false, profile: false, split: false
      }
      , { val: 'Meal Bolus'
        , name: 'Meal Bolus'
        , bg: true,  insulin: true,  carbs: true,  prebolus: true,  duration: false, percent: false, absolute: false, profile: false, split: false
      }
      , { val: 'Correction Bolus'
        , name: 'Correction Bolus'
        , bg: true,  insulin: true,  carbs: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false
      }
      , { val: 'Carb Correction'
        , name: 'Carb Correction'
        , bg: true,  insulin: false, carbs: true,  prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false
      }
      , { val: 'Combo Bolus'
        , name: 'Combo Bolus'
        , bg: true,  insulin: true,  carbs: true,  prebolus: true,  duration: true,  percent: false, absolute: false, profile: false, split: true
      }
      , { val: 'Announcement'
        , name: 'Announcement'
        , bg: true,  insulin: false, carbs: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false
      }
      , { val: 'Note'
        , name: 'Note'
        , bg: true,  insulin: false, carbs: false, prebolus: false, duration: true,  percent: false, absolute: false, profile: false, split: false
      }
      , { val: 'Question'
        , name: 'Question'
        , bg: true,  insulin: false, carbs: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false
      }
      , { val: 'Exercise'
        , name: 'Exercise'
        , bg: false, insulin: false, carbs: false, prebolus: false, duration: true,  percent: false, absolute: false, profile: false, split: false
      }
      , { val: 'Site Change'
        , name: 'Pump Site Change'
        , bg: true,  insulin: true,  carbs: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false
      }
      , { val: 'Sensor Start'
        , name: 'CGM Sensor Start'
        , bg: true,  insulin: false, carbs: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false
      }
      , { val: 'Sensor Change'
        , name: 'CGM Sensor Change'
        , bg: true,  insulin: false, carbs: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false
      }
      , { val: 'Insulin Change'
        , name: 'Insulin Cartridge Change'
        , bg: true,  insulin: false, carbs: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false
      }
      , { val: 'Temp Basal Start'
        , name: 'Temp Basal Start'
        , bg: true,  insulin: false, carbs: false, prebolus: false, duration: true,  percent: true,  absolute: true,  profile: false, split: false
      }
      , { val: 'Temp Basal End'
        , name: 'Temp Basal End'
        , bg: true,  insulin: false, carbs: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false
      }
      , { val: 'Profile Switch'
        , name: 'Profile Switch'
        , bg: true,  insulin: false, carbs: false, prebolus: false, duration: false, percent: false, absolute: false, profile: true,  split: false
      }
      , { val: 'D.A.D. Alert'
        , name: 'D.A.D. Alert'
        , bg: true,  insulin: false, carbs: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false
      }
    ];

  };

  return careportal;
}

module.exports = init;