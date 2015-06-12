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

    if (results.lastSGV < sbx.data.profile.target_high) return;

    //TODO: not sure where these will come from yet
    var snoozeBWP = sbx.properties.snoozeBWP || 0.10;
    var warnBWP = sbx.properties.warnBWP || 0.35;
    var urgentBWP = sbx.properties.urgentBWP || 0.75;

    if (results.lastSGV > sbx.thresholds.bg_target_top && results.bolusEstimate < snoozeBWP) {
      sbx.notifications.requestSnooze({
        level: 2
        , mills: FIFTEEN_MINS
        , debug: results
      })
    } else if (results.bolusEstimate > warnBWP) {
      var level = results.bolusEstimate > urgentBWP ? 2 : 1;
      var levelLabel = results.bolusEstimate > urgentBWP ? 'Urgent' : 'Warning';
      var message = [levelLabel, results.lastSGV, sbx.unitsLabel].join(' ');
      sbx.notifications.requestNotify({
        level: level
        , title: 'Check BG, time to bolus?'
        , message: message
        , debug: results
      });
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

    results.lastSGV = sgv;

    if (sgv == undefined || !sbx.properties.iob) return results;

    var profile = sbx.data.profile;

    if (!profile.target_high || !profile.target_low) {
      console.warn('For the BolusWizardPreview plugin to function your treatment profile must hava a both target_high and target_low fields');
    }

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