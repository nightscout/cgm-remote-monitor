'use strict';

var _ = require('lodash');

var TEN_MINS = 10 * 60 * 1000;

function init() {

  function bwp() {
    return bwp;
  }

  bwp.label = 'Bolus Wizard Preview';
  bwp.pluginType = 'pill-minor';

  function hasRequiredInfo (sbx) {

    if (!sbx.data.profile) { return false; }
    
    if (!sbx.data.profile.hasData()) {
      console.warn('For the BolusWizardPreview plugin to function you need a treatment profile');
      return false;
    }

    if (!sbx.data.profile.getSensitivity(sbx.time) || !sbx.data.profile.getHighBGTarget(sbx.time) || !sbx.data.profile.getLowBGTarget(sbx.time)) {
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

  bwp.setProperties = function setProperties(sbx) {
    sbx.offerProperty('bwp', function setBWP ( ) {
      if (hasRequiredInfo(sbx)) {
        return bwp.calc(sbx);
      }
    });
  };


  bwp.checkNotifications = function checkNotifications (sbx) {

    var results = sbx.properties.bwp;
    if (results === undefined) { return; }

    if (results.lastSGV < sbx.data.profile.getHighBGTarget(sbx.time)) { return; }

    var snoozeBWP = Number(sbx.extendedSettings.snooze) || 0.10;
    var warnBWP = Number(sbx.extendedSettings.warn) || 0.50;
    var urgentBWP = Number(sbx.extendedSettings.urgent) || 1.00;

    var snoozeLength = (sbx.extendedSettings.snoozeMins && Number(sbx.extendedSettings.snoozeMins) * 60 * 1000) || TEN_MINS;

    if (results.lastSGV > sbx.thresholds.bg_target_top && results.bolusEstimate < snoozeBWP) {
      sbx.notifications.requestSnooze({
        level: sbx.notifications.levels.URGENT
        , lengthMills: snoozeLength
        , debug: results
      });
    } else if (results.bolusEstimate > warnBWP) {
      var level = results.bolusEstimate > urgentBWP ? sbx.notifications.levels.URGENT : sbx.notifications.levels.WARN;
      var levelLabel = sbx.notifications.levels.toString(level);
      var sound = level === sbx.notifications.levels.URGENT ? 'updown' : 'bike';

      var lines = ['BG Now: ' + results.displaySGV];

      var delta = sbx.properties.delta && sbx.properties.delta.display;
      if (delta) {
        lines[0] += ' ' + delta;
      }
      lines[0] += ' ' + sbx.unitsLabel;

      var rawbgProp = sbx.properties.rawbg;
      if (rawbgProp) {
        lines.push(['Raw BG:', sbx.scaleBg(rawbgProp.value), sbx.unitsLabel, rawbgProp.noiseLabel].join(' '));
      }

      lines.push(['BWP:', results.bolusEstimateDisplay, 'U'].join(' '));

      var iob = sbx.properties.iob && sbx.properties.iob.display;
      if (iob) {
        lines.push(['IOB:', iob, 'U'].join(' '));
      }

      var cob = sbx.properties.cob && sbx.properties.cob.display;
      if (cob) {
        lines.push(['COB:', cob, 'g'].join(' '));
      }

      var message = lines.join('\n');

      sbx.notifications.requestNotify({
        level: level
        , title: levelLabel + ', Check BG, time to bolus?'
        , message: message
        , eventName: 'bwp'
        , pushoverSound: sound
        , plugin: bwp
        , debug: results
      });
    }
  };


  bwp.updateVisualisation = function updateVisualisation (sbx) {

    var results = sbx.properties.bwp;
    if (results === undefined) { return; }

    // display text
    var info = [
      {label: 'Insulin on Board', value: results.displayIOB + 'U'}
      ,
      {label: 'Expected effect', value: '-' + results.effectDisplay + ' ' + sbx.units}
      ,
      {label: 'Expected outcome', value: results.outcomeDisplay + ' ' + sbx.units}
    ];

    if (results.tempBasalAdjustment) {
      if (results.tempBasalAdjustment.thirtymin > 0) {
        info.push({label: '30m temp basal', value: results.tempBasalAdjustment.thirtymin + '%'});
      } else {
        info.push({label: '30m temp basal', value: 'too large adjustment needed, give carbs?'});
      }
      if (results.tempBasalAdjustment.onehour > 0) {
        info.push({label: '1h temp basal', value: results.tempBasalAdjustment.onehour + '%'});
      } else {
        info.push({label: '1h temp basal', value: 'too large adjustment needed, give carbs?'});
      }
    }

    sbx.pluginBase.updatePillText(bwp, {
      value: results.bolusEstimateDisplay + 'U'
      , label: 'BWP'
      , info: info
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
    results.displaySGV = sbx.displayBg(sbx.data.lastSGV());

    if (!hasRequiredInfo(sbx)) {
      return results;
    }

    var profile = sbx.data.profile;
    var iob = results.iob = sbx.properties.iob.iob;

    results.effect = iob * profile.getSensitivity(sbx.time);
    results.outcome = sgv - results.effect;
    var delta = 0;
    
    var target_high = profile.getHighBGTarget(sbx.time);
    var sens = profile.getSensitivity(sbx.time);

    if (results.outcome > target_high) {
      delta = results.outcome - target_high;
      results.bolusEstimate = delta / sens;
    }

    var target_low = profile.getLowBGTarget(sbx.time);

    if (results.outcome < target_low) {
      delta = Math.abs(results.outcome - target_low);
      results.bolusEstimate = delta / sens * -1;
    }
    
    if (results.bolusEstimate !== 0 && sbx.data.profile.getBasal()) {
      // Basal profile exists, calculate % change
      var basal = sbx.data.profile.getBasal(sbx.time);
      
      var thirtyMinAdjustment = Math.round((basal/2 + results.bolusEstimate) / (basal / 2) * 100);
      var oneHourAdjustment = Math.round((basal + results.bolusEstimate) / basal * 100);
      
      results.tempBasalAdjustment = {
        'thirtymin': thirtyMinAdjustment
        ,'onehour': oneHourAdjustment};
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