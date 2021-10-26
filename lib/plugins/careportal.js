'use strict';

var moment = require('moment');
var consts = require('../constants');

function init(ctx) {
  var translate = ctx.language.translate;

  var careportal = {
    name: 'careportal'
    , label: 'Care Portal'
    , pluginType: 'drawer'
  };

  careportal.getEventTypes = function getEventTypes () {

    //TODO: use sbx and new CAREPORTAL_EVENTTYPE_GROUPS="core temps combo dad sensor site etc"

    return [
      { val: '<none>'
        , name: '<none>'
        , bg: true, insulin: true, carbs: true, protein: false, fat: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false, sensor: false
      }
      , { val: 'BG Check'
        , name: 'BG Check'
        , bg: true, insulin: false, carbs: false, protein: false, fat: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false, sensor: false
      }
      , { val: 'Snack Bolus'
        , name: 'Snack Bolus'
        , bg: true, insulin: true, carbs: true, protein: true, fat: true, prebolus: true, duration: false, percent: false, absolute: false, profile: false, split: false, sensor: false
      }
      , { val: 'Meal Bolus'
        , name: 'Meal Bolus'
        , bg: true, insulin: true, carbs: true, protein: true, fat: true, prebolus: true, duration: false, percent: false, absolute: false, profile: false, split: false, sensor: false
      }
      , { val: 'Correction Bolus'
        , name: 'Correction Bolus'
        , bg: true, insulin: true, carbs: false, protein: false, fat: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false, sensor: false
      }
      , { val: 'Carb Correction'
        , name: 'Carb Correction'
        , bg: true, insulin: false, carbs: true, protein: true, fat: true, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false, sensor: false
      }
      , { val: 'Combo Bolus'
        , name: 'Combo Bolus'
        , bg: true, insulin: true, carbs: true, protein: true, fat: true, prebolus: true, duration: true, percent: false, absolute: false, profile: false, split: true, sensor: false
      }
      , { val: 'Announcement'
        , name: 'Announcement'
        , bg: true, insulin: false, carbs: false, protein: false, fat: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false, sensor: false
      }
      , { val: 'Note'
        , name: 'Note'
        , bg: true, insulin: false, carbs: false, protein: false, fat: false, prebolus: false, duration: true, percent: false, absolute: false, profile: false, split: false, sensor: false
      }
      , { val: 'Question'
        , name: 'Question'
        , bg: true, insulin: false, carbs: false, protein: false, fat: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false, sensor: false
      }
      , { val: 'Exercise'
        , name: 'Exercise'
        , bg: false, insulin: false, carbs: false, protein: false, fat: false, prebolus: false, duration: true, percent: false, absolute: false, profile: false, split: false, sensor: false
      }
      , { val: 'Site Change'
        , name: 'Pump Site Change'
        , bg: true, insulin: true, carbs: false, protein: false, fat: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false, sensor: false
      }
      , { val: 'Sensor Start'
        , name: 'CGM Sensor Start'
        , bg: true, insulin: false, carbs: false, protein: false, fat: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false, sensor: true
      }
      , { val: 'Sensor Change'
        , name: 'CGM Sensor Insert'
        , bg: true, insulin: false, carbs: false, protein: false, fat: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false, sensor: true
      }
      , { val: 'Sensor Stop'
        , name: 'CGM Sensor Stop'
        , bg: true,  insulin: false, carbs: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false, sensor: false
      }
      , { val: 'Pump Battery Change'
        , name: 'Pump Battery Change'
        , bg: true, insulin: false, carbs: false, protein: false, fat: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false, sensor: false
      }
      , { val: 'Insulin Change'
        , name: 'Insulin Cartridge Change'
        , bg: true, insulin: false, carbs: false, protein: false, fat: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false, sensor: false
      }
      , { val: 'Temp Basal Start'
        , name: 'Temp Basal Start'
        , bg: true, insulin: false, carbs: false, protein: false, fat: false, prebolus: false, duration: true, percent: true, absolute: true, profile: false, split: false, sensor: false
      }
      , { val: 'Temp Basal End'
        , name: 'Temp Basal End'
        , bg: true, insulin: false, carbs: false, protein: false, fat: false, prebolus: false, duration: true, percent: false, absolute: false, profile: false, split: false, sensor: false
      }
      , { val: 'Profile Switch'
        , name: 'Profile Switch'
        , bg: true, insulin: false, carbs: false, protein: false, fat: false, prebolus: false, duration: true, percent: false, absolute: false, profile: true, split: false, sensor: false
      }
      , { val: 'D.A.D. Alert'
        , name: 'D.A.D. Alert'
        , bg: true, insulin: false, carbs: false, protein: false, fat: false, prebolus: false, duration: false, percent: false, absolute: false, profile: false, split: false, sensor: false
      }
    ];

  };

  function virtAsstEating(next, slots, sbx) {
    var createdAt = sbx.virtAsst.getCreatedAt(slots);

    if (!slots.number) {
      next(translate('virtAsstMissingCarbsTitle'), translate('virtAsstMissingCarbsText'));
      return;
    }

    var treatments = [{
      eventType: '<none>'
      , enteredBy: 'Virtual Assistant'
      , carbs: slots.number
      , created_at: createdAt.toISOString()
    }];

    sbx.virtAsstCtx.treatments.create(treatments, function(err, created) {
      if (err) {
        console.log('Error adding treatment', err);
        next(translate('virtAsstDbErrTitle'), translate('virtAsstDbErrText'));
      } else {
        console.log('Virtual assistant treatment created', created);
        next(translate('virtAsstSavedTitle'), translate('virtAsstCarbs', {params: [slots.number]}));
      }
    });
  }

  function virtAsstEatingConfirm(slots, sbx) {
    // no need for a fancy confirmation if there's no date
    var hasRelTime = sbx.virtAsst.hasRelTime(slots);
    if (!hasRelTime) {
      return false;
    }

    var createdAt = sbx.virtAsst.getCreatedAt(slots)
    , timeAgo = moment(createdAt).calendar();
    return translate('virtAsstEatingConfirmDate', {params: [slots.number, timeAgo]});
  }

  function virtAsstBgCheck(next, slots, sbx) {
    var createdAt = sbx.virtAsst.getCreatedAt(slots)
      , units = sbx.settings.units;

    if (!slots.number) {
      next(translate('virtAsstMissingBgTitle'), translate('virtAsstMissingBgText'));
      return;
    } else if (units === 'mmol') { // adjust units if necessary
      slots.number *= consts.MMOL_TO_MGDL;
    }

    var treatments = [{
      eventType: 'BG Check'
      , enteredBy: 'Virtual Assistant'
      , glucose: slots.number
      , created_at: createdAt.toISOString()
    }];

    sbx.virtAsstCtx.treatments.create(treatments, function(err, created) {
      if (err) {
        console.log('Error adding treatment', err);
        next(translate('virtAsstDbErrTitle'), translate('virtAsstDbErrText'));
      } else {
        console.log('Virtual assistant treatment created', created);
        next(translate('virtAsstSavedTitle'), translate('virtAsstBg', {params: [slots.number]}));
      }
    });
  }

  function virtAsstBgCheckConfirm(slots, sbx) {
    // no need for a fancy confirmation if there's no date
    var hasRelTime = sbx.virtAsst.hasRelTime(slots);
    if (!hasRelTime) {
      return false;
    }

    var createdAt = sbx.virtAsst.getCreatedAt(slots)
    , timeAgo = moment(createdAt).calendar();
    return translate('virtAsstBgCheckConfirmDate', {params: [slots.number, timeAgo]});
  }

  function virtAsstExercise(next, slots, sbx) {
    var duration = sbx.virtAsst.durationToMinutes(slots);
    var createdAt = sbx.virtAsst.getCreatedAt(slots);

    if (!duration) {
      next(translate('virtAsstMissingDurationTitle'), translate('virtAsstMissingExerciseText'));
      return;
    }

    var treatments = [{
      eventType: 'Exercise'
      , enteredBy: 'Virtual Assistant'
      , duration
      , created_at: createdAt.toISOString()
    }];

    sbx.virtAsstCtx.treatments.create(treatments, function(err, created) {
      if (err) {
        console.log('Error adding treatment', err);
        next(translate('virtAsstDbErrTitle'), translate('virtAsstDbErrText'));
      } else {
        console.log('Virtual assistant treatment created', created);
        next(translate('virtAsstSavedTitle'), translate('virtAsstExercise', {params: [duration]}));
      }
    });
  }

  function virtAsstExerciseConfirm(slots, sbx) {
    var duration = sbx.virtAsst.durationToMinutes(slots)
      , hasRelTime = sbx.virtAsst.hasRelTime(slots);

    if (hasRelTime) {
      var createdAt = sbx.virtAsst.getCreatedAt(slots)
        , timeAgo = moment(createdAt).calendar();

      return translate('virtAsstExerciseConfirmDate', {params: [duration, timeAgo]});
    } else {
      return translate('virtAsstExerciseConfirm', {params: [duration]});
    }
  }

  function virtAsstActivityMode(next, slots, sbx) {
    var duration = sbx.virtAsst.durationToMinutes(slots);
    var createdAt = sbx.virtAsst.getCreatedAt(slots);

    if (!duration) {
      next(translate('virtAsstMissingDurationTitle'), translate('virtAsstMissingActivityText'));
      return;
    }

    var treatments = [{
      eventType: 'Temporary Target'
      , enteredBy: 'Virtual Assistant'
      , reason: 'Activity'
      , targetTop: 140
      , targetBottom: 120
      , duration
      , created_at: createdAt.toISOString()
    }];

    sbx.virtAsstCtx.treatments.create(treatments, function(err, created) {
      if (err) {
        console.log('Error adding treatment', err);
        next(translate('virtAsstDbErrTitle'), translate('virtAsstDbErrText'));
      } else {
        console.log('Virtual assistant treatment created', created);
        next(translate('virtAsstSavedTitle'), translate('virtAsstActivityMode', {params: [duration]}));
      }
    });
  }

  function virtAsstActivityConfirm(slots, sbx) {
    var duration = sbx.virtAsst.durationToMinutes(slots)
      , hasRelTime = sbx.virtAsst.hasRelTime(slots);

    if (hasRelTime) {
      var createdAt = sbx.virtAsst.getCreatedAt(slots)
        , timeAgo = moment(createdAt).calendar();

      return translate('virtAsstActivityConfirmDate', {params: [duration, timeAgo]});
    } else {
      return translate('virtAsstActivityConfirm', {params: [duration]});
    }
  }

  function virtAsstEatingSoon(next, slots, sbx) {
    var createdAt = sbx.virtAsst.getCreatedAt(slots);

    var treatments = [{
      eventType: 'Temporary Target'
      , enteredBy: 'Virtual Assistant'
      , reason: 'Eating Soon'
      , targetTop: 80
      , targetBottom: 80
      , duration: 60
      , created_at: createdAt.toISOString()
    }];

    sbx.virtAsstCtx.treatments.create(treatments, function(err, created) {
      if (err) {
        console.log('Error adding treatment', err);
        next(translate('virtAsstDbErrTitle'), translate('virtAsstDbErrText'));
      } else {
        console.log('Virtual assistant treatment created', created);
        next(translate('virtAsstSavedTitle'), translate('virtAsstEatingSoon'));
      }
    });
  }

  function virtAsstSiteChange(next, slots, sbx) {
    var createdAt = sbx.virtAsst.getCreatedAt(slots);

    var treatments = [{
      eventType: 'Site Change'
      , enteredBy: 'Virtual Assistant'
      , created_at: createdAt.toISOString()
    }];

    sbx.virtAsstCtx.treatments.create(treatments, function(err, created) {
      if (err) {
        console.log('Error adding treatment', err);
        next(translate('virtAsstDbErrTitle'), translate('virtAsstDbErrText'));
      } else {
        console.log('Virtual assistant treatment created', created);
        next(translate('virtAsstSavedTitle'), translate('virtAsstSiteChange'));
      }
    });
  }

  function virtAsstSiteChangeConfirm(slots, sbx) {
    // no need for a fancy confirmation if there's no date
    var hasRelTime = sbx.virtAsst.hasRelTime(slots);
    if (!hasRelTime) {
      return false;
    }

    var createdAt = sbx.virtAsst.getCreatedAt(slots)
      , timeAgo = moment(createdAt).calendar();

    return translate('virtAsstSiteChangeConfirmDate', {params: [timeAgo]});
  }

  function virtAsstPumpBattChange(next, slots, sbx) {
    var createdAt = sbx.virtAsst.getCreatedAt(slots);

    var treatments = [{
      eventType: 'Pump Battery Change'
      , enteredBy: 'Virtual Assistant'
      , created_at: createdAt.toISOString()
    }];

    sbx.virtAsstCtx.treatments.create(treatments, function(err, created) {
      if (err) {
        console.log('Error adding treatment', err);
        next(translate('virtAsstDbErrTitle'), translate('virtAsstDbErrText'));
      } else {
        console.log('Virtual assistant treatment created', created);
        next(translate('virtAsstSavedTitle'), translate('virtAsstPumpBattChange'));
      }
    });
  }

  function virtAsstPumpBattChangeConfirm(slots, sbx) {
    // no need for a fancy confirmation if there's no date
    var hasRelTime = sbx.virtAsst.hasRelTime(slots);
    if (!hasRelTime) {
      return false;
    }

    var createdAt = sbx.virtAsst.getCreatedAt(slots)
      , timeAgo = moment(createdAt).calendar();

    return translate('virtAsstPumpBattChangeConfirmDate', {params: [timeAgo]});
  }

  function virtAsstCartridgeChange(next, slots, sbx) {
    var createdAt = sbx.virtAsst.getCreatedAt(slots);

    var treatments = [{
      eventType: 'Insulin Change'
      , enteredBy: 'Virtual Assistant'
      , created_at: createdAt.toISOString()
    }];

    sbx.virtAsstCtx.treatments.create(treatments, function(err, created) {
      if (err) {
        console.log('Error adding treatment', err);
        next(translate('virtAsstDbErrTitle'), translate('virtAsstDbErrText'));
      } else {
        console.log('Virtual assistant treatment created', created);
        next(translate('virtAsstSavedTitle'), translate('virtAsstCartridgeChange'));
      }
    });
  }

  function virtAsstCartridgeChangeConfirm(slots, sbx) {
    // no need for a fancy confirmation if there's no date
    var hasRelTime = sbx.virtAsst.hasRelTime(slots);
    if (!hasRelTime) {
      return false;
    }

    var createdAt = sbx.virtAsst.getCreatedAt(slots)
      , timeAgo = moment(createdAt).calendar();

    return translate('virtAsstCartridgeChangeConfirmDate', {params: [timeAgo]});
  }

  function virtAsstTempTarget(next, slots, sbx) {
    var createdAt = sbx.virtAsst.getCreatedAt(slots)
      , duration = sbx.virtAsst.durationToMinutes(slots)
      , units = sbx.settings.units;

    if (!slots.target_top) {
      next(translate('virtAsstMissingTempTargetTitle'), translate('virtAsstMissingTempTargetText'));
      return;
    } else if (!slots.duration) {
      next(translate('virtAsstMissingDurationTitle'), translate('virtAsstMissingTargetDurationText'));
      return;
    }

    // input validation
    if (!slots.target_bottom) {
      // set bottom to same as top if we don't have it
      slots.target_bottom = slots.target_top;
    } else if (slots.target_top < slots.target_bottom) {
      // the virtual assistant probably mixed up the two, or the user said them in the opposite order
      var old = slots.target_bottom;
      slots.target_bottom = slots.target_top;
      slots.target_top = old;
    }
    
    // adjust units if necessary
    var targetTop = slots.target_top
      , targetBottom = slots.target_bottom;
    if (units === 'mmol') {
      targetTop *= consts.MMOL_TO_MGDL;
      targetBottom *= consts.MMOL_TO_MGDL;
    }

    var treatments = [{
      eventType: 'Temporary Target'
      , enteredBy: 'Virtual Assistant'
      , reason: 'Manual'
      , targetTop
      , targetBottom
      , duration
      , created_at: createdAt.toISOString()
    }];

    sbx.virtAsstCtx.treatments.create(treatments, function(err, created) {
      if (err) {
        console.log('Error adding treatment', err);
        next(translate('virtAsstDbErrTitle'), translate('virtAsstDbErrText'));
      } else {
        console.log('Virtual assistant treatment created', created);
        next(translate('virtAsstSavedTitle'), translate('virtAsstTempTarget', {params: [slots.target_bottom, slots.target_top, duration]}));
      }
    });
  }

  function virtAsstTempTargetConfirm(slots, sbx) {
    var duration = sbx.virtAsst.durationToMinutes(slots)
      , hasRelTime = sbx.virtAsst.hasRelTime(slots);

    // input validation
    if (!slots.target_bottom) {
      // set bottom to same as top if we don't have it
      slots.target_bottom = slots.target_top;
    } else if (slots.target_top < slots.target_bottom) {
      // the virtual assistant probably mixed up the two, or the user said them in the opposite order
      var old = slots.target_bottom;
      slots.target_bottom = slots.target_top;
      slots.target_top = old;
    }

    if (hasRelTime) {
      var createdAt = sbx.virtAsst.getCreatedAt(slots)
        , timeAgo = moment(createdAt).calendar();

      return translate('virtAsstTempTargetConfirmDate', {params: [slots.target_bottom, slots.target_top, duration, timeAgo]});
    } else {
      return translate('virtAsstTempTargetConfirm', {params: [slots.target_bottom, slots.target_top, duration]});
    }
  }

  function virtAsstCancelTempTarget(next, slots, sbx) {
    var createdAt = sbx.virtAsst.getCreatedAt(slots);

    var treatments = [{
      eventType: 'Temporary Target'
      , enteredBy: 'Virtual Assistant'
      , targetTop: ''
      , targetBottom: ''
      , duration: 0
      , created_at: createdAt.toISOString()
    }];

    sbx.virtAsstCtx.treatments.create(treatments, function(err, created) {
      if (err) {
        console.log('Error adding treatment', err);
        next(translate('virtAsstDbErrTitle'), translate('virtAsstDbErrText'));
      } else {
        console.log('Virtual assistant treatment created', created);
        next(translate('virtAsstSavedTitle'), translate('virtAsstCancelTempTarget'));
      }
    });
  }

  function virtAsstCancelTempTargetConfirm(slots, sbx) {
    // no need for a fancy confirmation if there's no date
    var hasRelTime = sbx.virtAsst.hasRelTime(slots);
    if (!hasRelTime) {
      return false;
    }

    var createdAt = sbx.virtAsst.getCreatedAt(slots)
      , timeAgo = moment(createdAt).calendar();

    return translate('virtAsstCancelTempTargetConfirmDate', {params: [timeAgo]});
  }

  careportal.virtAsst = {
    intentHandlers: [
      {
        intent: 'MetricReportCarbs'
        , createAccess: true
        , intentHandler: virtAsstEating
        , alexaSettings: {
          requiredFields: [
            'number'
          ]
          , intentConfirmer: virtAsstEatingConfirm
        }
      }
      , {
        intent: 'MetricReportBgCheck'
        , createAccess: true
        , intentHandler: virtAsstBgCheck
        , alexaSettings: {
          requiredFields: [
            'number'
          ]
          , intentConfirmer: virtAsstBgCheckConfirm
        }
      }
      , {
        intent: 'MetricReportExercise'
        , createAccess: true
        , intentHandler: virtAsstExercise
        , alexaSettings: {
          requiredFields: [
            'duration'
          ]
          , intentConfirmer: virtAsstExerciseConfirm
        }
      }
      , {
        intent: 'MetricReportActivityMode'
        , createAccess: true
        , intentHandler: virtAsstActivityMode
        , alexaSettings: {
          requiredFields: [
            'duration'
          ]
          , intentConfirmer: virtAsstActivityConfirm
        }
      }
      , {
        intent: 'MetricReportEatingSoon'
        , createAccess: true
        , intentHandler: virtAsstEatingSoon
        , alexaSettings: {}
      }
      , {
        intent: 'MetricReportSiteChange'
        , createAccess: true
        , intentHandler: virtAsstSiteChange
        , alexaSettings: {
          requiredFields: []
          , intentConfirmer: virtAsstSiteChangeConfirm
        }
      }
      , {
        intent: 'MetricReportPumpBattChange'
        , createAccess: true
        , intentHandler: virtAsstPumpBattChange
        , alexaSettings: {
          requiredFields: []
          , intentConfirmer: virtAsstPumpBattChangeConfirm
        }
      }
      , {
        intent: 'MetricReportCartridgeChange'
        , createAccess: true
        , intentHandler: virtAsstCartridgeChange
        , alexaSettings: {
          requiredFields: []
          , intentConfirmer: virtAsstCartridgeChangeConfirm
        }
      }
      , {
        intent: 'MetricReportTempTarget'
        , createAccess: true
        , intentHandler: virtAsstTempTarget
        , alexaSettings: {
          requiredFields: [
            'target_top'
            , 'duration'
          ]
          , intentConfirmer: virtAsstTempTargetConfirm
        }
      }
      , {
        intent: 'MetricReportCancelTempTarget'
        , createAccess: true
        , intentHandler: virtAsstCancelTempTarget
        , alexaSettings: {
          requiredFields: []
          , intentConfirmer: virtAsstCancelTempTargetConfirm
        }
      }
    ]
  };

  return careportal;
}

module.exports = init;
