'use strict';

var _ = require('lodash');
var rawbg = require('../plugins/rawbg')();

module.exports = function fitTreatmentsToBGCurve (ddata, settings) {

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

      return calcedBG || 180;
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

    if (treatment.glucose && isNaN(treatment.glucose)) {
      console.warn('found an invalid glucose value', treatment);
    } else if (treatment.glucose && treatment.units) {
      if (treatment.units === 'mmol') {
        treatment.mmol = Number(treatment.glucose);
      } else {
        treatment.mgdl = Number(treatment.glucose);
      }
    } else if (treatment.glucose) {
      //no units, assume everything is the same
      //console.warn('found a glucose value without any units, maybe from an old version?', _.pick(treatment, '_id', 'created_at', 'enteredBy'));
      var units = settings.units === 'mmol' ? 'mmol' : 'mgdl';
      treatment[units] = Number(treatment.glucose);
    } else {
      treatment.mgdl = mgdlByTime();
    }
  }

  _.each(ddata.treatments, updateTreatmentBG);

};

