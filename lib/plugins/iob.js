'use strict';

var _ = require('lodash')
  , moment = require('moment')
  , nsutils = require('../nsutils')();

function init() {

  function iob() {
    return iob;
  }

  iob.label = 'Insulin-on-Board';

  iob.getData = function getData() {
    return iob.calcTotal(this.env.treatments, this.env.profile, this.env.time);
  };

  iob.calcTotal = function calcTotal(treatments, profile, time) {

    var totalIOB = 0
      , totalActivity = 0;

    if (!treatments) return {};

    if (profile === undefined) {
      //if there is no profile default to 3 hour dia
      profile = {dia: 3, sens: 0};
    }

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
        if (tIOB && tIOB.iobContrib) totalIOB += tIOB.iobContrib;
        if (tIOB && tIOB.activityContrib) totalActivity += tIOB.activityContrib;
      }
    });

    return {
      iob: totalIOB,
      display: nsutils.toFixed(totalIOB),
      activity: totalActivity,
      lastBolus: lastBolus
    };
  };

  iob.calcTreatment = function calcTreatment(treatment, profile, time) {

    var dia = profile.dia
      , scaleFactor = 3.0 / dia
      , peak = 75
      , sens = profile.sens
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

  iob.updateVisualisation = function updateVisualisation() {
    var info = null;

    if (this.iob.lastBolus) {
      var when = moment(new Date(this.iob.lastBolus.created_at)).format('lll');
      var amount = this.roundInsulinForDisplayFormat(Number(this.iob.lastBolus.insulin)) + 'U';
      info = [{label: 'Last Bolus', value: amount + ' @ ' + when }]
    }

    this.updatePillText(this.roundInsulinForDisplayFormat(this.iob.display) + 'U', 'IOB', info, true);
  };

  return iob();

}

module.exports = init;