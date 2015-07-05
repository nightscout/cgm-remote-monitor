'use strict';

var _ = require('lodash')
  , moment = require('moment')
  , utils = require('../utils')();

function init() {

  function iob() {
    return iob;
  }

  iob.label = 'Insulin-on-Board';
  iob.pluginType = 'pill-major';

  iob.setProperties = function setProperties(sbx) {
    sbx.offerProperty('iob', function setIOB ( ) {
      return iob.calcTotal(sbx.data.treatments, sbx.data.profile, sbx.time);
    });
  };

  iob.calcTotal = function calcTotal(treatments, profile, time) {

    var totalIOB = 0
      , totalActivity = 0;

    if (!treatments) { return {}; }

    if (time === undefined) {
      time = new Date();
    }

    var lastBolus = null;

    _.forEach(treatments, function eachTreatment(treatment) {
      if (new Date(treatment.created_at) < time) {
        var tIOB = iob.calcTreatment(treatment, profile, time);
        if (tIOB.iobContrib > 0) {
          lastBolus = treatment;
        }
        if (tIOB && tIOB.iobContrib) { totalIOB += tIOB.iobContrib; }
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

  iob.calcTreatment = function calcTreatment(treatment, profile, time) {

    var dia = 3
      , sens = 0;

    if (profile !== undefined) {
      dia = profile.getDIA();
      sens = profile.getSensitivity(time);
    }

    var scaleFactor = 3.0 / dia
      , peak = 75
      , result = {
          iobContrib: 0
          , activityContrib: 0
        };

    if (treatment.insulin) {
      var bolusTime = new Date(treatment.created_at);
      var minAgo = scaleFactor * (time - bolusTime) / 1000 / 60;

      if (minAgo < peak) {
        var x1 = minAgo / 5 + 1;
        result.iobContrib = treatment.insulin * (1 - 0.001852 * x1 * x1 + 0.001852 * x1);
        result.activityContrib = sens * treatment.insulin * (2 / dia / 60 / peak) * minAgo;

      } else if (minAgo < 180) {
        var x2 = (minAgo - 75) / 5;
        result.iobContrib = treatment.insulin * (0.001323 * x2 * x2 - .054233 * x2 + .55556);
        result.activityContrib = sens * treatment.insulin * (2 / dia / 60 - (minAgo - peak) * 2 / dia / 60 / (60 * dia - peak));
      }

    }

    return result;

  };

  iob.updateVisualisation = function updateVisualisation(sbx) {
    var info = null;

    var prop = sbx.properties.iob;

    if (prop && prop.lastBolus) {
      var when = moment(new Date(prop.lastBolus.created_at)).format('lll');
      var amount = sbx.roundInsulinForDisplayFormat(Number(prop.lastBolus.insulin)) + 'U';
      info = [{label: 'Last Bolus', value: amount + ' @ ' + when }];
    }

    sbx.pluginBase.updatePillText(iob, {
      value: sbx.roundInsulinForDisplayFormat(prop.display) + 'U'
      , label: 'IOB'
      , info: info
    });

  };

  return iob();

}

module.exports = init;