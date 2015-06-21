'use strict';

var _ = require('lodash')
  , iob = require('./iob')()
  , moment = require('moment');

function init() {

  function cob() {
    return cob;
  }

  cob.label = 'Carbs-on-Board';
  cob.pluginType = 'pill-minor';


  cob.setProperties = function setProperties(sbx) {
    sbx.offerProperty('cob', function setCOB ( ) {
      return cob.cobTotal(sbx.data.treatments, sbx.data.profile, sbx.time);
    });
  };

  cob.cobTotal = function cobTotal(treatments, profile, time) {

    if (!profile) {
      console.warn('For the COB plugin to function you need a treatment profile');
      return {};
    }

    if (!profile.sens || !profile.carbratio) {
      console.warn('For the CPB plugin to function your treatment profile must have both sens and carbratio fields');
      return {};
    }

    var liverSensRatio = 1;
    var sens = profile.sens;
    var carbratio = profile.carbratio;
    var totalCOB = 0;
    var lastCarbs = null;
    if (!treatments) return {};
    if (typeof time === 'undefined') {
      time = new Date();
    }

    var isDecaying = 0;
    var lastDecayedBy = new Date('1/1/1970');
    var carbs_hr = profile.carbs_hr;

    _.forEach(treatments, function eachTreatment(treatment) {
      if (treatment.carbs && treatment.created_at < time) {
        lastCarbs = treatment;
        var cCalc = cob.cobCalc(treatment, profile, lastDecayedBy, time);
        var decaysin_hr = (cCalc.decayedBy - time) / 1000 / 60 / 60;
        if (decaysin_hr > -10) {
          var actStart = iob.calcTotal(treatments, lastDecayedBy).activity;
          var actEnd = iob.calcTotal(treatments, cCalc.decayedBy).activity;
          var avgActivity = (actStart + actEnd) / 2;
          var delayedCarbs = avgActivity * liverSensRatio * sens / carbratio;
          var delayMinutes = Math.round(delayedCarbs / carbs_hr * 60);
          if (delayMinutes > 0) {
            cCalc.decayedBy.setMinutes(cCalc.decayedBy.getMinutes() + delayMinutes);
            decaysin_hr = (cCalc.decayedBy - time) / 1000 / 60 / 60;
          }
        }

        if (cCalc) {
          lastDecayedBy = cCalc.decayedBy;
        }

        if (decaysin_hr > 0) {
          //console.info('Adding ' + delayMinutes + ' minutes to decay of ' + treatment.carbs + 'g bolus at ' + treatment.created_at);
          totalCOB += Math.min(Number(treatment.carbs), decaysin_hr * carbs_hr);
          //console.log("cob: " + Math.min(cCalc.initialCarbs, decaysin_hr * carbs_hr));
          isDecaying = cCalc.isDecaying;
        } else {
          totalCOB = 0;
        }

      }
    });

    var rawCarbImpact = isDecaying * sens / carbratio * carbs_hr / 60;

    return {
      decayedBy: lastDecayedBy,
      isDecaying: isDecaying,
      carbs_hr: carbs_hr,
      rawCarbImpact: rawCarbImpact,
      cob: totalCOB,
      lastCarbs: lastCarbs
    };
  };

  cob.carbImpact = function carbImpact(rawCarbImpact, insulinImpact) {
    var liverSensRatio = 1.0;
    var liverCarbImpactMax = 0.7;
    var liverCarbImpact = Math.min(liverCarbImpactMax, liverSensRatio * insulinImpact);
    //var liverCarbImpact = liverSensRatio*insulinImpact;
    var netCarbImpact = Math.max(0, rawCarbImpact - liverCarbImpact);
    var totalImpact = netCarbImpact - insulinImpact;
    return {
      netCarbImpact: netCarbImpact,
      totalImpact: totalImpact
    }
  };

  cob.cobCalc = function cobCalc(treatment, profile, lastDecayedBy, time) {

    var carbs_hr = profile.carbs_hr;
    var delay = 20;
    var carbs_min = carbs_hr / 60;
    var isDecaying = 0;
    var initialCarbs;

    if (treatment.carbs) {
      var carbTime = new Date(treatment.created_at);

      var decayedBy = new Date(carbTime);
      var minutesleft = (lastDecayedBy - carbTime) / 1000 / 60;
      decayedBy.setMinutes(decayedBy.getMinutes() + Math.max(delay, minutesleft) + treatment.carbs / carbs_min);
      if (delay > minutesleft) {
        initialCarbs = parseInt(treatment.carbs);
      }
      else {
        initialCarbs = parseInt(treatment.carbs) + minutesleft * carbs_min;
      }
      var startDecay = new Date(carbTime);
      startDecay.setMinutes(carbTime.getMinutes() + delay);
      if (time < lastDecayedBy || time > startDecay) {
        isDecaying = 1;
      }
      else {
        isDecaying = 0;
      }
      return {
        initialCarbs: initialCarbs,
        decayedBy: decayedBy,
        isDecaying: isDecaying,
        carbTime: carbTime
      };
    }
    else {
      return '';
    }
  };

  cob.updateVisualisation = function updateVisualisation(sbx) {

    var prop = sbx.properties.cob.cob;
    if (prop == undefined) return;

    var displayCob = Math.round(prop * 10) / 10;

    var info = null;
    if (prop.lastCarbs) {
      var when = moment(new Date(prop.lastCarbs.created_at)).format('lll');
      var amount = prop.lastCarbs.carbs + 'g';
      info = [{label: 'Last Carbs', value: amount + ' @ ' + when }]
    }

    sbx.pluginBase.updatePillText(sbx, {
      value: displayCob + " g"
      , label: 'COB'
      , info: info
    });
  };

  return cob();

}

module.exports = init;
