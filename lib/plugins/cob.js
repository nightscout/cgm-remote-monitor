'use strict';

var _ = require('lodash')
  , iob = require('./iob')()
  , moment = require('moment');

function init() {

  var cob = {
    name: 'cob'
    , label: 'Carbs-on-Board'
    , pluginType: 'pill-minor'
  };

  cob.setProperties = function setProperties(sbx) {
    sbx.offerProperty('cob', function setCOB ( ) {
      return cob.cobTotal(sbx.data.treatments, sbx.data.profile, sbx.time);
    });
  };

  cob.cobTotal = function cobTotal(treatments, profile, time) {

    if (!profile || !profile.hasData()) {
      console.warn('For the COB plugin to function you need a treatment profile');
      return {};
    }

    if (!profile.getSensitivity(time) || !profile.getCarbRatio(time)) {
      console.warn('For the CPB plugin to function your treatment profile must have both sens and carbratio fields');
      return {};
    }

    // TODO: figure out the liverSensRatio that gives the most accurate purple line predictions
    var liverSensRatio = 8;
    var totalCOB = 0;
    var lastCarbs = null;

    if (!treatments) {
      return {};
    }

    if (typeof time === 'undefined') {
      time = Date.now();
    }

    var isDecaying = 0;
    var lastDecayedBy = 0;

    _.each(treatments, function eachTreatment(treatment) {
      if (treatment.carbs && treatment.mills < time) {
        lastCarbs = treatment;
        var cCalc = cob.cobCalc(treatment, profile, lastDecayedBy, time);
        var decaysin_hr = (cCalc.decayedBy - time) / 1000 / 60 / 60;
        if (decaysin_hr > -10) {
          // units: BG
          var actStart = iob.calcTotal(treatments, profile, lastDecayedBy).activity;
          var actEnd = iob.calcTotal(treatments, profile, cCalc.decayedBy).activity;
          var avgActivity = (actStart + actEnd) / 2;
          // units:  g     =       BG      *      scalar     /          BG / U                           *     g / U
          var delayedCarbs = ( avgActivity *  liverSensRatio / profile.getSensitivity(treatment.mills) ) * profile.getCarbRatio(treatment.mills);
          var delayMinutes = Math.round(delayedCarbs / profile.getCarbAbsorptionRate(treatment.mills) * 60);
          if (delayMinutes > 0) {
            cCalc.decayedBy.setMinutes(cCalc.decayedBy.getMinutes() + delayMinutes);
            decaysin_hr = (cCalc.decayedBy - time) / 1000 / 60 / 60;
          }
        }

        if (cCalc) {
          lastDecayedBy = cCalc.decayedBy;
        }

        if (decaysin_hr > 0) {
          //console.info('Adding ' + delayMinutes + ' minutes to decay of ' + treatment.carbs + 'g bolus at ' + treatment.mills);
          totalCOB += Math.min(Number(treatment.carbs), decaysin_hr * profile.getCarbAbsorptionRate(treatment.mills));
          //console.log("cob:", Math.min(cCalc.initialCarbs, decaysin_hr * profile.getCarbAbsorptionRate(treatment.mills)),cCalc.initialCarbs,decaysin_hr,profile.getCarbAbsorptionRate(treatment.mills));
          isDecaying = cCalc.isDecaying;
        } else {
          totalCOB = 0;
        }

      }
    });

    var rawCarbImpact = isDecaying * profile.getSensitivity(time) / profile.getCarbRatio(time) * profile.getCarbAbsorptionRate(time) / 60;
    var display = Math.round(totalCOB * 10) / 10;
    return {
      decayedBy: lastDecayedBy
      , isDecaying: isDecaying
      , carbs_hr: profile.getCarbAbsorptionRate(time)
      , rawCarbImpact: rawCarbImpact
      , cob: totalCOB
      , display: display
      , displayLine: 'COB: ' + display + 'g'
      , lastCarbs: lastCarbs
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
    };
  };

  cob.cobCalc = function cobCalc(treatment, profile, lastDecayedBy, time) {

    var delay = 20;
    var isDecaying = 0;
    var initialCarbs;

    if (treatment.carbs) {
      var carbTime = new Date(treatment.mills);
      
      var carbs_hr = profile.getCarbAbsorptionRate(treatment.mills);
      var carbs_min = carbs_hr / 60;

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

    var prop = sbx.properties.cob;

    if (prop === undefined || prop.cob === undefined) { return; }

    var displayCob = Math.round(prop.cob * 10) / 10;

    var info = null;
    if (prop.lastCarbs) {
      var when = moment(prop.lastCarbs.mills).format('lll');
      var amount = prop.lastCarbs.carbs + 'g';
      info = [{label: 'Last Carbs', value: amount + ' @ ' + when }];
    }

    sbx.pluginBase.updatePillText(sbx, {
      value: displayCob + 'g'
      , label: 'COB'
      , info: info
    });
  };

  return cob;

}

module.exports = init;
