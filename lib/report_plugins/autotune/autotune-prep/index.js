
// Prep step before autotune.js can run; pulls in meal (carb) data and calls categorize.js

var tz = require('moment-timezone');
var find_meals = require('../meal/history');
var categorize = require('./categorize');

function generate (inputs) {

  //console.error(inputs);
  var treatments = find_meals(inputs);

  var opts = {
    treatments: treatments
  , profile: inputs.profile
  , pumpHistory: inputs.history
  , glucose: inputs.glucose
  //, prepped_glucose: inputs.prepped_glucose
  , basalprofile: inputs.profile.basalprofile
  };

  if ( inputs.pumpprofile ) {
    opts.pumpbasalprofile = inputs.pumpprofile.basalprofile;
  } else {
    opts.pumpbasalprofile = inputs.profile.basalprofile;
  }
  var autotune_prep_output = categorize(opts);
  return autotune_prep_output;
}

exports = module.exports = generate;
