'use strict';

var _ = require('lodash')
  , moment = require('moment')
  , utils = require('../utils')();

function init() {
  var iob = {
    name: 'iob'
    , label: 'Insulin-on-Board'
    , pluginType: 'pill-major'
  };

  function usePumpIOB (sbx) {
    return sbx.withExtendedSettings(iob).extendedSettings.source === 'pump';
  }

  iob.calc = function calc (sbx, time, spec_profile) {
    // Choose calculation mode at runtime, when we can get extended settings from the sandbox
    if (usePumpIOB(sbx)) {
      return iob.getPumpIOB(sbx.data.pumpStatuses, sbx.withExtendedSettings(iob).extendedSettings, time);
    } else {
      return iob.calcTotal(sbx.data.treatments, sbx.data.profile, time, spec_profile);
    }
  };

  iob.setProperties = function setProperties (sbx) {
    sbx.offerProperty('iob', function setIOB () {
      return iob.calc(sbx, sbx.time);
    });
  };

  iob.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.iob
      , info
      , value;

    if (usePumpIOB(sbx)) {
      if (!_.isEmpty(prop)) {
        value = prop.display + 'U';
        if (prop.uploaderBattery) {
          info = [{label: 'Uploader Battery', value: prop.uploaderBattery + '%'}];
        }
      } else {
        value = '---';
        info = [{label: 'Pump IOB', value: 'No recent data'}];
      }
    } else {
      if (prop && prop.lastBolus) {
        var when = moment(prop.lastBolus.mills).format('lll');
        var amount = sbx.roundInsulinForDisplayFormat(Number(prop.lastBolus.insulin)) + 'U';
        info = [{label: 'Last Bolus', value: amount + ' @ ' + when }];
      }
      value = sbx.roundInsulinForDisplayFormat(prop.display) + 'U';
    }

    sbx.pluginBase.updatePillText(iob, {
      label: 'IOB'
      , value: value
      , info: info
    });
  };

  iob.getPumpIOB = function getPumpIOB (pumpStatuses, settings, time) {
    settings = _.cloneDeep(settings);
    settings.pumpRecency = settings.pumpRecency !== undefined ? parseInt(settings.pumpRecency, 10) : 10;
    // 25 is the MiniMed Connect's threshold for LOW vs MEDIUM
    settings.pumpBatteryPebble = settings.pumpBatteryPebble !== undefined ? parseInt(settings.pumpBatteryPebble, 10) : 25;

    var lastPumpStatus = _.last(_.dropRightWhile(pumpStatuses, function (pumpStatus) {
      return pumpStatus.mills > time;
    }));

    if (!lastPumpStatus || lastPumpStatus.activeInsulin === undefined) {
      return {};
    } else if (time - lastPumpStatus.mills > settings.pumpRecency * 60 * 1000) {
      return {};
    } else {
      var iob = lastPumpStatus.activeInsulin;
      var display = iob.toFixed(1);

      var pebbleDisplay = display;
      if (settings.pumpBatteryPebble && lastPumpStatus.conduitBatteryLevel <= settings.pumpBatteryPebble) {
        pebbleDisplay += '*';
      }

      return {
        iob: iob
        , display: display
        , displayLine: 'IOB: ' + display + 'U'
        , pebbleDisplay: pebbleDisplay
        , uploaderBattery: lastPumpStatus.conduitBatteryLevel
      };
    }
  };

  // TODO(@mddub|2015-11-02): remove these and use https://github.com/nightscout/dcalc
  // when that package exposes these functions
  iob.calcTotal = function calcTotal(treatments, profile, time, spec_profile) {

    var totalIOB = 0
      , totalActivity = 0;

    if (!treatments) { return {}; }

    if (time === undefined) {
      time = Date.now();
    }

    var lastBolus = null;

    _.each(treatments, function eachTreatment(treatment) {
      if (treatment.mills <= time) {
        var tIOB = iob.calcTreatment(treatment, profile, time, spec_profile);
        if (tIOB.iobContrib > 0) {
          lastBolus = treatment;
        }
        if (tIOB && tIOB.iobContrib) { totalIOB += tIOB.iobContrib; }
        // units: BG (mg/dL or mmol/L)
        if (tIOB && tIOB.activityContrib) { totalActivity += tIOB.activityContrib; }
      }
    });

    var display = utils.toFixed(totalIOB);
    return {
      iob: totalIOB
      , display: display
      , displayLine: 'IOB: ' + display + 'U'
      , activity: totalActivity
      , lastBolus: lastBolus
    };
  };

  iob.calcTreatment = function calcTreatment(treatment, profile, time, spec_profile) {

    var dia = 3
      , sens = 0;

    if (profile !== undefined) {
      dia = profile.getDIA(time, spec_profile) || 3;
      sens = profile.getSensitivity(time, spec_profile);
    }

    var scaleFactor = 3.0 / dia
      , peak = 75
      , result = {
          iobContrib: 0
          , activityContrib: 0
        };

    if (treatment.insulin) {
      var bolusTime = treatment.mills;
      var minAgo = scaleFactor * (time - bolusTime) / 1000 / 60;

      if (minAgo < peak) {
        var x1 = minAgo / 5 + 1;
        result.iobContrib = treatment.insulin * (1 - 0.001852 * x1 * x1 + 0.001852 * x1);
        // units: BG (mg/dL)  = (BG/U) *    U insulin     * scalar
        result.activityContrib = sens * treatment.insulin * (2 / dia / 60 / peak) * minAgo;

      } else if (minAgo < 180) {
        var x2 = (minAgo - 75) / 5;
        result.iobContrib = treatment.insulin * (0.001323 * x2 * x2 - 0.054233 * x2 + 0.55556);
        result.activityContrib = sens * treatment.insulin * (2 / dia / 60 - (minAgo - peak) * 2 / dia / 60 / (60 * dia - peak));
      }

    }

    return result;

  };

  return iob;
}

module.exports = init;
