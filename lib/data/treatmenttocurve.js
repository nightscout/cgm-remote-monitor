'use strict';

var _ = require('lodash');
var consts = require('../constants');
var { guessUnitFromValueAndHint, guessUnitByProximity } = require('../units')();

const MAX_BG_MMOL = 22;
const MAX_BG_MGDL = MAX_BG_MMOL * consts.MMOL_TO_MGDL;

module.exports = function fitTreatmentsToBGCurve (ddata, env, ctx) {

  var settings = env.settings;
  var rawbg = require('../plugins/rawbg')({
    settings: settings
    , language: ctx.language
  });

  function updateTreatmentBG(treatment) {

    function mgdlByTime() {

      var withBGs = _.filter(ddata.sgvs, function(d) {
        return d.mgdl > 39 || settings.isEnabled('rawbg');
      });

      var beforeTreatment = _.findLast(withBGs, function (d) {
        return d.mills <= treatment.mills;
      });
      var afterTreatment = _.find(withBGs, function (d) {
        return d.mills >= treatment.mills;
      });

      var mgdlBefore = mgdlValue(beforeTreatment) || calcRaw(beforeTreatment);
      var mgdlAfter = mgdlValue(afterTreatment) || calcRaw(afterTreatment);

      var calcedBG = 0;
      if (mgdlBefore && mgdlAfter) {
        calcedBG = (mgdlBefore + mgdlAfter) / 2;
      } else if (mgdlBefore) {
        calcedBG = mgdlBefore;
      } else if (mgdlAfter) {
        calcedBG = mgdlAfter;
      }

      return Math.round(calcedBG) || 180;
    }

    function mgdlValue (entry) {
      return entry && entry.mgdl >= 39 && Number(entry.mgdl);
    }

    function calcRaw (entry) {
      var raw;
      if (entry && settings.isEnabled('rawbg')) {
        var cal = _.last(ddata.cals);
        if (cal) {
          raw = rawbg.calc(entry, cal);
        }
      }
      return raw;
    }

    //to avoid checking if eventType is null everywhere, just default it here
    treatment.eventType = treatment.eventType || '';

    // 1. treatment.glucose missing          → synthesize BG from nearby SGVs via mgdlByTime()
    // 2. treatment.glucose is NaN           → warn and skip
    // 3. treatment.units recognized         → use it directly (trusted, no guessing)
    // 4. value >= 40                        → unambiguously mg/dL
    // 5. value <= 25                        → unambiguously mmol/L
    // 6. value 26-39, no unit stored        → guess via proximity to nearest interpolated SGV
    if (treatment.glucose && isNaN(treatment.glucose)) {
      console.warn('found an invalid glucose value', treatment);
    } else if (treatment.glucose) {
      var value = Number(treatment.glucose);
      var unit = guessUnitFromValueAndHint(value, treatment.units);
      if (unit === null) {
      // Uses mgdlByTime() as the reference — falls back to 180 mg/dL when no SGVs are available,
      // which biases toward mg/dL in that edge case.
        unit = guessUnitByProximity(value, mgdlByTime());
      }
      if (unit === 'mmol') {
        treatment.mmol = Math.min(value, MAX_BG_MMOL);
      } else {
        treatment.mgdl = Math.min(value, MAX_BG_MGDL);
      }
    } else {
      treatment.mgdl = mgdlByTime();
    }
  }

  _.each(ddata.treatments, updateTreatmentBG);

};

