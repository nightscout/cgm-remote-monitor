
var basal = require('./basal');
var targets = require('./targets');
var isf = require('./isf');
var carb_ratios = require('./carbs');
var _ = require('lodash');

function defaults ( ) {
  var profile = {
    max_iob: 0 // if max_iob is not provided, never give more insulin than the pump would have
   // , type: 'current'
    , max_daily_safety_multiplier: 3
    , current_basal_safety_multiplier: 4
    , autosens_max: 1.2
    , autosens_min: 0.7
    , autosens_adjust_targets: true
    , override_high_target_with_low: false
    , skip_neutral_temps: false
    , bolussnooze_dia_divisor: 2
    , min_5m_carbimpact: 3 //mg/dL/5m
    , carbratio_adjustmentratio: 1 //if carb ratios on pump are set higher to lower initial bolus using wizard, .8 = assume only 80 percent of carbs covered with full bolus
  };
  return profile;
}

function generate (inputs, opts) {
  var profile = opts && opts.type ? opts : defaults( );

  // check if inputs has overrides for any of the default prefs
  // and apply if applicable
  for (var pref in profile) {
    if (inputs.hasOwnProperty(pref)) {
      profile[pref] = inputs[pref];
    }
  }

  var pumpsettings_data = inputs.settings;
  if (inputs.settings.insulin_action_curve > 1) {
    profile.dia =  pumpsettings_data.insulin_action_curve;
  } else {
    console.error('DIA of', profile.dia, 'is not supported');
    return -1;
  }

  if (inputs.model) {
    profile.model = inputs.model;
  }
  profile.skip_neutral_temps = inputs.skip_neutral_temps;

  profile.current_basal = basal.basalLookup(inputs.basals);
  profile.basalprofile = inputs.basals;
  
  _.forEach(profile.basalprofile, function(basalentry) {
    basalentry.rate = +(Math.round(basalentry.rate + "e+3")  + "e-3");		
  });
  
  profile.max_daily_basal = basal.maxDailyBasal(inputs);
  profile.max_basal = basal.maxBasalLookup(inputs);
  if (profile.current_basal === 0) {
    console.error("current_basal of",profile.current_basal,"is not supported");
    return -1;
  }
  if (profile.max_daily_basal === 0) {
    console.error("max_daily_basal of",profile.max_daily_basal,"is not supported");
    return -1;
  }
  if (profile.max_basal < 0.1) {
    console.error("max_basal of",profile.max_basal,"is not supported");
    return -1;
  }

  var range = targets.bgTargetsLookup(inputs, profile);
  profile.out_units = inputs.targets.user_preferred_units;
  profile.min_bg = Math.round(range.min_bg);
  profile.max_bg = Math.round(range.max_bg);
  profile.bg_targets = inputs.targets;
  
  _.forEach(profile.bg_targets.targets, function(bg_entry) {
    bg_entry.high = Math.round(bg_entry.high);
    bg_entry.low = Math.round(bg_entry.low);
    bg_entry.min_bg = Math.round(bg_entry.min_bg);
    bg_entry.max_bg = Math.round(bg_entry.max_bg);
  });
  
  delete profile.bg_targets.raw;
  
  profile.temptargetSet = range.temptargetSet;
  profile.sens = isf.isfLookup(inputs.isf);
  profile.isfProfile = inputs.isf;
  if (profile.sens < 5) {
    console.error("ISF of",profile.sens,"is not supported");
    return -1;
  }
  if (typeof(inputs.carbratio) != "undefined") {
    profile.carb_ratio = carb_ratios.carbRatioLookup(inputs, profile);
    profile.carb_ratios = inputs.carbratio;
  } else {
    console.error("Profile wasn't given carb ratio data, cannot calculate carb_ratio");
  }

  return profile;
}


generate.defaults = defaults;
exports = module.exports = generate;

