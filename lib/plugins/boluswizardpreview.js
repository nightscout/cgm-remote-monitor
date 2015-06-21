'use strict';

var _ = require('lodash');


var TEN_MINS = 10 * 60 * 1000;
var FIFTEEN_MINS = 15 * 60 * 1000;

function init() {

  function bwp() {
    return bwp;
  }

  bwp.label = 'Bolus Wizard Preview';
  bwp.pluginType = 'pill-minor';

  function hasRequiredInfo (sbx) {
    if (!sbx.data.profile) {
      console.warn('For the BolusWizardPreview plugin to function you need a treatment profile');
      return false;
    }

    if (!sbx.data.profile.sens || !sbx.data.profile.target_high || !sbx.data.profile.target_low) {
      console.warn('For the BolusWizardPreview plugin to function your treatment profile must have both sens, target_high, and target_low fields');
      return false;
    }

    if (!sbx.properties.iob) {
      console.warn('For the BolusWizardPreview plugin to function the IOB plugin must also be enabled');
      return false;
    }

    var lastSGVEntry = _.last(sbx.data.sgvs);

    if (!lastSGVEntry || lastSGVEntry.y < 40 || Date.now() - lastSGVEntry.x > TEN_MINS) {
      console.warn('For the BolusWizardPreview plugin to function there needs to be a current SGV');
      return false;
    }

    return true;

  }

  bwp.checkNotifications = function checkNotifications (sbx) {

    if (!hasRequiredInfo(sbx)) {
      return;
    }

    var results = bwp.calc(sbx);

    if (results.lastSGV < sbx.data.profile.target_high) return;

    var snoozeBWP = Number(sbx.extendedSettings.snooze) || 0.10;
    var warnBWP = Number(sbx.extendedSettings.warn) || 0.50;
    var urgentBWP = Number(sbx.extendedSettings.urgent) || 1.00;

    var snoozeLength = (sbx.extendedSettings.snoozeMins && Number(sbx.extendedSettings.snoozeMins) * 60 * 1000) || TEN_MINS;

    if (results.lastSGV > sbx.thresholds.bg_target_top && results.bolusEstimate < snoozeBWP) {
      sbx.notifications.requestSnooze({
        level: sbx.notifications.levels.URGENT
        , lengthMills: snoozeLength
        , debug: results
      })
    } else if (results.bolusEstimate > warnBWP) {
      var level = results.bolusEstimate > urgentBWP ? sbx.notifications.levels.URGENT : sbx.notifications.levels.WARN;
      var levelLabel = sbx.notifications.levels.toString(level);
      var sound = level == sbx.notifications.levels.URGENT ? 'updown' : 'bike';
      var message = [levelLabel, results.lastSGV, sbx.unitsLabel].join(' ');
      var iob = sbx.properties.iob && sbx.properties.iob.display;
      if (iob) {
        message += ['\nIOB:', iob, 'U'].join(' ');
      }

      sbx.notifications.requestNotify({
        level: level
        , title: 'Check BG, time to bolus?'
        , message: message
        , pushoverSound: sound
        , plugin: bwp
        , debug: results
      });
    }
  };


  bwp.updateVisualisation = function updateVisualisation (sbx) {

    if (!hasRequiredInfo(sbx)) {
      return;
    }

    var results = bwp.calc(sbx);

    sbx.pluginBase.updatePillText(bwp, {
      value: results.bolusEstimateDisplay + 'U'
      , label: 'BWP'
      , info: [
        {label: 'Insulin on Board', value: results.displayIOB + 'U'}
        , {label: 'Expected effect', value: '-' + results.effectDisplay + ' ' + sbx.units}
        , {label: 'Expected outcome', value: results.outcomeDisplay + ' ' + sbx.units}
      ]
    });

  };

  bwp.calc = function calc (sbx) {

    var results = {
      effect: 0
      , outcome: 0
      , bolusEstimate: 0.0
    };

    var sgv = sbx.scaleBg(sbx.data.lastSGV());

    results.lastSGV = sgv;

    if (!hasRequiredInfo(sbx)) {
      return results;
    }

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