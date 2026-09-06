'use strict';

var times = require('../times');
var selectCOB = require('../client-core/devicestatus/cob');

  function init (ctx) {
  var utils = require('../utils')(ctx);
  var moment = ctx.moment;
  var translate = ctx.language.translate;
  var iob = require('./iob')(ctx);

  var cob = {
    name: 'cob'
    , label: 'Carbs-on-Board'
    , pluginType: 'pill-minor'
  };

  cob.RECENCY_THRESHOLD = times.mins(30).msecs;

  cob.setProperties = function setProperties (sbx) {
    sbx.offerProperty('cob', function setCOB () {
      return cob.cobTotal(sbx.data.treatments, sbx.data.devicestatus, sbx.data.profile, sbx.time);
    });
  };

  cob.cobTotal = function cobTotal (treatments, devicestatus, profile, time, spec_profile) {

    if (typeof time === 'undefined') {
      time = Date.now();
    } else if (time && time.getTime) {
      time = time.getTime();
    }

    // sens and carbratio are needed only by the treatment-derived model
    var hasProfile = Boolean(profile && profile.hasData()
      && profile.getSensitivity(time, spec_profile)
      && profile.getCarbRatio(time, spec_profile));

    var hasTreatments = treatments !== undefined && treatments.length > 0;

    const TEN_MINUTES = 10 * 60 * 1000;
    var result = cob.lastCOBDeviceStatus(devicestatus, time);
    var deviceCOBIsCurrent = result.cob != null && (time - result.mills) <= TEN_MINUTES;

    if (deviceCOBIsCurrent) {
      if (hasProfile && hasTreatments) {
        var comparison = cob.fromTreatments(treatments, devicestatus, profile, time, spec_profile);
        if (comparison.cob) {
          result = Object.assign({}, result, { treatmentCOB: comparison.cob });
        }
      }
      return addDisplay(result);
    }

    if (!hasProfile) {
      console.warn('For the COB plugin to derive COB from treatments you need a treatment profile with both sens and carbratio fields');
      return {};
    }

    var treatmentCOB = hasTreatments ? cob.fromTreatments(treatments, devicestatus, profile, time, spec_profile) : {};

    // detaches lastCarbs from the treatment record and renders decayedBy as an ISO string
    result = JSON.parse(JSON.stringify(treatmentCOB));
    result.source = translate('Care Portal');

    return addDisplay(result);
  };
  function addDisplay (cob) {
    if (!cob || Object.keys(cob).length === 0 || cob.cob === undefined) {
      return {};
    }

    var display = Math.round(cob.cob * 10) / 10;
    return Object.assign({}, cob, {
      display: display
      , displayLine: 'COB: ' + display + 'g'
    });
  }
  cob.isDeviceStatusAvailable = function isDeviceStatusAvailable (devicestatus) {
    return Array.isArray(devicestatus) && devicestatus
      .map(cob.fromDeviceStatus)
      .filter(item => !utils.isEmpty(item))
      .length > 0;
  };

  cob.lastCOBDeviceStatus = function lastCOBDeviceStatus (devicestatus, time) {
    // Handle cases where devicestatus is undefined, null, or not an array
    if (!Array.isArray(devicestatus)) {
      return {};
    }

    if (time && time.getTime) {
      time = time.getTime();
    }

    var futureMills = time + times.mins(5).msecs; //allow for clocks to be a little off
    var recentMills = time - cob.RECENCY_THRESHOLD;
    const filteredResults = devicestatus
      .filter(function(cobStatus) {
        return cobStatus.mills <= futureMills && cobStatus.mills >= recentMills;
      })
      .map(cob.fromDeviceStatus)
      .filter(item => !utils.isEmpty(item))
      .sort((a, b) => (a.mills || 0) - (b.mills || 0));

    return filteredResults.length ? filteredResults[filteredResults.length - 1] : {};
  };
  cob.COBDeviceStatusesInTimeRange = function COBDeviceStatusesInTimeRange (devicestatus, from, to) {
    // Handle cases where devicestatus is undefined, null, or not an array
    if (!Array.isArray(devicestatus)) {
      return [];
    }

    return devicestatus
      .filter(function(cobStatus) {
        return cobStatus.mills > from && cobStatus.mills < to;
      })
      .map(cob.fromDeviceStatus)
      .filter(item => !utils.isEmpty(item))
      .sort((a, b) => (a.mills || 0) - (b.mills || 0));
  };

  cob.fromDeviceStatus = function fromDeviceStatus (devicestatusEntry) {
    return selectCOB(devicestatusEntry, { moment: moment });
  };

  cob.fromTreatments = function fromTreatments (treatments, devicestatus, profile, time, spec_profile) {
    // TODO: figure out the liverSensRatio that gives the most accurate purple line predictions
    var liverSensRatio = 8;
    var totalCOB = 0;
    var lastCarbs = null;

    var isDecaying = 0;
    var lastDecayedBy = 0;

    treatments?.forEach(function eachTreatment (treatment) {
      if (treatment.carbs && treatment.mills < time) {
        lastCarbs = treatment;
        var cCalc = cob.cobCalc(treatment, profile, lastDecayedBy, time, spec_profile);
        var decaysin_hr = (cCalc.decayedBy - time) / 1000 / 60 / 60;
        if (decaysin_hr > -10) {
          // units: BG
          var actStart = iob.calcTotal(treatments, devicestatus, profile, lastDecayedBy, spec_profile).activity;
          var actEnd = iob.calcTotal(treatments, devicestatus, profile, cCalc.decayedBy, spec_profile).activity;
          var avgActivity = (actStart + actEnd) / 2;
          // units:  g     =       BG      *      scalar     /          BG / U                           *     g / U
          var delayedCarbs = (avgActivity * liverSensRatio / profile.getSensitivity(treatment.mills, spec_profile)) * profile.getCarbRatio(treatment.mills, spec_profile);
          var delayMinutes = Math.round(delayedCarbs / profile.getCarbAbsorptionRate(treatment.mills, spec_profile) * 60);
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
          totalCOB += Math.min(Number(treatment.carbs), decaysin_hr * profile.getCarbAbsorptionRate(treatment.mills, spec_profile));
          //console.log('cob:', Math.min(cCalc.initialCarbs, decaysin_hr * profile.getCarbAbsorptionRate(treatment.mills)),cCalc.initialCarbs,decaysin_hr,profile.getCarbAbsorptionRate(treatment.mills));
          isDecaying = cCalc.isDecaying;
        } else {
          totalCOB = 0;
        }

      }
    });

    var rawCarbImpact = isDecaying * profile.getSensitivity(time, spec_profile) / profile.getCarbRatio(time, spec_profile) * profile.getCarbAbsorptionRate(time, spec_profile) / 60;

    return {
      decayedBy: lastDecayedBy
      , isDecaying: isDecaying
      , carbs_hr: profile.getCarbAbsorptionRate(time, spec_profile)
      , rawCarbImpact: rawCarbImpact
      , cob: totalCOB
      , lastCarbs: lastCarbs
    };
  };

  cob.carbImpact = function carbImpact (rawCarbImpact, insulinImpact) {
    var liverSensRatio = 1.0;
    var liverCarbImpactMax = 0.7;
    var liverCarbImpact = Math.min(liverCarbImpactMax, liverSensRatio * insulinImpact);
    //var liverCarbImpact = liverSensRatio*insulinImpact;
    var netCarbImpact = Math.max(0, rawCarbImpact - liverCarbImpact);
    var totalImpact = netCarbImpact - insulinImpact;
    return {
      netCarbImpact: netCarbImpact
      , totalImpact: totalImpact
    };
  };

  cob.cobCalc = function cobCalc (treatment, profile, lastDecayedBy, time, spec_profile) {

    var delay = 20;
    var isDecaying = 0;
    var initialCarbs;

    if (treatment.carbs) {
      var carbTime = new Date(treatment.mills);

      var carbs_hr = profile.getCarbAbsorptionRate(treatment.mills, spec_profile);
      var carbs_min = carbs_hr / 60;

      var decayedBy = new Date(carbTime);
      var minutesleft = (lastDecayedBy - carbTime) / 1000 / 60;
      decayedBy.setMinutes(decayedBy.getMinutes() + Math.max(delay, minutesleft) + treatment.carbs / carbs_min);
      if (delay > minutesleft) {
        initialCarbs = parseInt(treatment.carbs);
      } else {
        initialCarbs = parseInt(treatment.carbs) + minutesleft * carbs_min;
      }
      var startDecay = new Date(carbTime);
      startDecay.setMinutes(carbTime.getMinutes() + delay);
      if (time < lastDecayedBy || time > startDecay) {
        isDecaying = 1;
      } else {
        isDecaying = 0;
      }
      return {
        initialCarbs: initialCarbs
        , decayedBy: decayedBy
        , isDecaying: isDecaying
        , carbTime: carbTime
      };
    } else {
      return '';
    }
  };

  cob.updateVisualisation = function updateVisualisation (sbx) {

    var prop = sbx.properties.cob;

    if (prop === undefined || prop.cob === undefined) { return; }

    var displayCob = Math.round(prop.cob * 10) / 10;

    var info = [];

    if (prop.source !== undefined) {
      info.push({ label: translate('Source'), value: prop.source });
    }

    if (prop.device !== undefined) {
      info.push({ label: translate('Device'), value: prop.device });
    }

    if (prop.treatmentCOB !== undefined) {
      info.push({ label: '------------', value: '' });
      info.push({ label: translate('Careportal COB'), value: Math.round(prop.treatmentCOB * 10) / 10 });
    }

    if (prop.lastCarbs) {
      var when = new Date(prop.lastCarbs.mills).toLocaleString();
      var amount = prop.lastCarbs.carbs + 'g';
      info.push({ label: translate('Last Carbs'), value: amount + ' @ ' + when });
    }

    sbx.pluginBase.updatePillText(cob, {
      value: displayCob + 'g'
      , label: translate('COB')
      , info: info
    });
  };
  function virtAsstCOBHandler (next, slots, sbx) {
    var response = '';
    var cob = sbx?.properties?.cob?.cob;
    var pwd = slots?.pwd?.value;
    var value = cob ? cob : 0;
    if (pwd) {
      response = translate('virtAsstCob3person', {
        params: [
          pwd.replace('\'s', '')
          , value
        ]
      });
    } else {
      response = translate('virtAsstCob', {
        params: [
          value
        ]
      });
    }
    next(translate('virtAsstTitleCurrentCOB'), response);
  }

  cob.virtAsst = {
    intentHandlers: [{
      intent: 'MetricNow'
      , metrics: ['cob', 'carbs on board', 'carbohydrates on board']
      , intentHandler: virtAsstCOBHandler
    }]
  };

  return cob;

}

module.exports = init;
