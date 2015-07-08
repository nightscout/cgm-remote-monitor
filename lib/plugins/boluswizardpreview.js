'use strict';

var TEN_MINS = 10 * 60 * 1000;

function init() {

  function bwp() {
    return bwp;
  }

  bwp.label = 'Bolus Wizard Preview';
  bwp.pluginType = 'pill-minor';

  function hasRequiredInfo (sbx) {

    var warnings = [];
    if (!sbx.data.profile || !sbx.data.profile.hasData()) {
      warnings.push('Missing need a treatment profile');
    }

    if (!sbx.data.profile.getSensitivity(sbx.time) || !sbx.data.profile.getHighBGTarget(sbx.time) || !sbx.data.profile.getLowBGTarget(sbx.time)) {
      warnings.push('Missing sens, target_high, or target_low treatment profile fields');
    }

    if (!sbx.properties.iob) {
      warnings.push('Missing IOB property');
    }

    if (sbx.lastSGV() < 40 || sbx.time - sbx.lastSGVMills() > TEN_MINS) {
      warnings.push('Data isn\'t current');
    }

    if (warnings.length > 0) {
      console.warn('BWP plugin doesn\'t have required info: ' + warnings.join('; '));
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

    var prop = sbx.properties.bwp;
    if (prop === undefined) { return; }

    var settings = prepareSettings(sbx);

    if (bwp.highSnoozedByIOB(prop, settings, sbx)) {
      sbx.notifications.requestSnooze({
        level: sbx.notifications.levels.URGENT
        , title: 'Snoozing high alarm since there is enough IOB'
        , message: [sbx.propertyLine('bwp'), sbx.propertyLine('iob')].join('\n')
        , lengthMills: settings.snoozeLength
        , debug: prop
      });
    } else if (prop.lastSGV > sbx.data.profile.getHighBGTarget(sbx.time) && prop.bolusEstimate > settings.warnBWP) {
      var level = prop.bolusEstimate > settings.urgentBWP ? sbx.notifications.levels.URGENT : sbx.notifications.levels.WARN;
      var levelLabel = sbx.notifications.levels.toString(level);
      var sound = level === sbx.notifications.levels.URGENT ? 'updown' : 'bike';

      sbx.notifications.requestNotify({
        level: level
        , title: levelLabel + ', Check BG, time to bolus?'
        , message: sbx.buildDefaultMessage()
        , eventName: 'bwp'
        , pushoverSound: sound
        , plugin: bwp
        , debug: prop
      });
    }
  };

  bwp.highSnoozedByIOB = function highSnoozedByIOB(prop, settings, sbx) {
    var ar2EventType = sbx.properties.ar2 && sbx.properties.ar2.eventType;
    var high = ar2EventType === 'high' || prop.lastSGV >= sbx.thresholds.bg_target_top;

    return high && prop.bolusEstimate < settings.snoozeBWP;
  };


  bwp.updateVisualisation = function updateVisualisation (sbx) {

    var prop = sbx.properties.bwp;
    if (prop === undefined) { return; }

    // display text
    var info = [
      {label: 'Insulin on Board', value: prop.displayIOB + 'U'}
      , {label: 'Sensitivity', value: '-' + sbx.data.profile.getSensitivity(sbx.time) + ' ' + sbx.units + '/U'}
      , {label: 'Expected effect', value: prop.displayIOB + ' x -' + sbx.data.profile.getSensitivity(sbx.time) + ' = -' + prop.effectDisplay + ' ' + sbx.units}
      , {label: 'Expected outcome', value: sbx.lastScaledSGV() + '-' + prop.effectDisplay + ' = ' + prop.outcomeDisplay + ' ' + sbx.units}
    ];

    if (prop.tempBasalAdjustment) {
      
      var carbsOrBolusMessage = 'too large adjustment needed, give carbs?';
      var sign = '';
      if (prop.tempBasalAdjustment.thirtymin > 100) { carbsOrBolusMessage = 'too large adjustment needed, give bolus?'; sign = '+';}

      info.push({label: '---------', value: ''});      
      info.push({label: 'Current basal', value: sbx.data.profile.getBasal(sbx.time)});
      info.push({label: 'Basal change to account for ' + prop.bolusEstimateDisplay + ':', value: ''});
      
      if (prop.tempBasalAdjustment.thirtymin > 0 && prop.tempBasalAdjustment.thirtymin < 200) {
        info.push({label: '30m temp basal', value: ''+prop.tempBasalAdjustment.thirtymin + '% (' + sign + (prop.tempBasalAdjustment.thirtymin-100) + '%)'});
      } else {
        info.push({label: '30m temp basal', value: carbsOrBolusMessage});
      }
      if (prop.tempBasalAdjustment.onehour > 0 && prop.tempBasalAdjustment.onehour < 200) {
        info.push({label: '1h temp basal', value: ''+prop.tempBasalAdjustment.onehour + '% (' + sign + (prop.tempBasalAdjustment.onehour-100) + '%)'});
      } else {
        info.push({label: '1h temp basal', value: carbsOrBolusMessage});
      }
    }

    sbx.pluginBase.updatePillText(bwp, {
      value: prop.bolusEstimateDisplay + 'U'
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

    var sgv = sbx.lastScaledSGV();

    results.lastSGV = sgv;

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
    
    if (results.bolusEstimate !== 0 && sbx.data.profile.getBasal(sbx.time)) {
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
    results.displayLine = 'BWP: ' + results.bolusEstimateDisplay + 'U';

    return results;
  };

  function prepareSettings (sbx) {
    return {
      snoozeBWP: Number(sbx.extendedSettings.snooze) || 0.10
    , warnBWP: Number(sbx.extendedSettings.warn) || 0.50
    , urgentBWP: Number(sbx.extendedSettings.urgent) || 1.00
    , snoozeLength: (sbx.extendedSettings.snoozeMins && Number(sbx.extendedSettings.snoozeMins) * 60 * 1000) || TEN_MINS
    };
  }

  return bwp();

}

module.exports = init;