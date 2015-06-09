'use strict';

var _ = require('lodash');

var FIFTEEN_MINS = 15 * 60 * 1000;

function init() {

  function bwp() {
    return bwp;
  }

  bwp.label = 'Bolus Wizard Preview';
  bwp.pluginType = 'pill-minor';

  bwp.checkNotifications = function checkNotifications(sbx) {
    var results = bwp.calc(sbx);
    if (results.bolusEstimate < .25) {
      sbx.notifications.requestSnooze({
        level: 2
        , mills: FIFTEEN_MINS
        , debug: 'BWP: ' + results.bolusEstimateDisplay + 'U'
      })
    }
  };


  bwp.updateVisualisation = function updateVisualisation (sbx) {

    var results = bwp.calc(sbx);

    // display text
    var info = [
      {label: 'Insulin on Board', value: results.displayIOB + 'U'}
      , {label: 'Expected effect', value: '-' + results.effectDisplay + ' ' + sbx.units}
      , {label: 'Expected outcome', value: results.outcomeDisplay + ' ' + sbx.units}
    ];

    sbx.pluginBase.updatePillText(bwp, results.bolusEstimateDisplay + 'U', 'BWP', info);

  };

  bwp.calc = function calc (sbx) {

    var results = {
      effect: 0
      , outcome: 0
      , bolusEstimate: 0.0
    };

    var sgv = sbx.scaleBg(sbx.data.lastSGV());

    if (sgv == undefined || !sbx.properties.iob) return;

    var profile = sbx.data.profile;

    var iob = results.iob = sbx.properties.iob.iob;

    results.effect = iob * profile.sens;
    results.outcome = sgv - results.effect;
    var delta = 0;

    if (results.outcome > profile.target_high) {
      delta = results.outcome - profile.target_high;
      results.bolusEstimate = delta / profile.sens;
    }

    if (results.outcome < profile.target_low) {
      delta = Math.abs(results.outcome - profile.target_low);
      results.bolusEstimate = delta / profile.sens * -1;
    }

    results.bolusEstimateDisplay = sbx.roundInsulinForDisplayFormat(results.bolusEstimate);
    results.outcomeDisplay = sbx.roundBGToDisplayFormat(results.outcome);
    results.displayIOB = sbx.roundInsulinForDisplayFormat(results.iob);
    results.effectDisplay = sbx.roundBGToDisplayFormat(results.effect);

    return results;
  };

  return bwp();

}

module.exports = init;