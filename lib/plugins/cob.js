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

  cob.getData = function getData() {
    return cob.cobTotal(this.env.treatments, this.env.time);
  };

  cob.cobTotal = function cobTotal(treatments, time) {
    var liverSensRatio = 1;
    var sens = this.profile.sens;
    var carbratio = this.profile.carbratio;
    var totalCOB = 0;
    var lastCarbs = null;
    if (!treatments) return {};
    if (typeof time === 'undefined') {
      time = new Date();
    }

    var isDecaying = 0;
    var lastDecayedBy = new Date('1/1/1970');
    var carbs_hr = this.profile.carbs_hr;

    _.forEach(treatments, function eachTreatment(treatment) {
      if (treatment.carbs && treatment.created_at < time) {
        lastCarbs = treatment;
        var cCalc = cob.cobCalc(treatment, lastDecayedBy, time);
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

  cob.cobCalc = function cobCalc(treatment, lastDecayedBy, time) {

    var carbs_hr = this.profile.carbs_hr;
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

  cob.updateVisualisation = function updateVisualisation() {
    var displayCob = Math.round(this.env.cob.cob * 10) / 10;

    var info = null;
    if (this.env.cob.lastCarbs) {
      var when = moment(new Date(this.env.cob.lastCarbs.created_at)).format('lll');
      var amount = this.env.cob.lastCarbs.carbs + 'g';
      info = [{label: 'Last Carbs', value: amount + ' @ ' + when }]
    }

    this.updatePillText(displayCob + " g", 'COB', info);
  };

  return cob();

}

module.exports = init;
