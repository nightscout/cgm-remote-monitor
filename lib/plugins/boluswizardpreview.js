'use strict';

var _ = require('lodash');
var levels = require('../levels');
var times = require('../times');

function init() {

  var bwp = {
    name: 'bwp'
    , label: 'Bolus Wizard Preview'
    , pluginType: 'pill-minor'
  };

  function checkMissingInfo (sbx) {
    var errors = [];
    if (!sbx.data.profile || !sbx.data.profile.hasData()) {
      errors.push('Missing need a treatment profile');
    } else if (profileFieldsMissing(sbx)) {
      errors.push('Missing sens, target_high, or target_low treatment profile fields');
    }

    if (!sbx.properties.iob) {
      errors.push('Missing IOB property');
    }

    if (!isSGVOk(sbx)) {
      errors.push('Data isn\'t current');
    }

    return errors;
  }

  bwp.setProperties = function setProperties(sbx) {
    sbx.offerProperty('bwp', function setBWP ( ) {
      return bwp.calc(sbx);
    });
  };


  bwp.checkNotifications = function checkNotifications (sbx) {

    var prop = sbx.properties.bwp;
    if (prop === undefined) { return; }

    var settings = prepareSettings(sbx);

    if (bwp.highSnoozedByIOB(prop, settings, sbx)) {
      sbx.notifications.requestSnooze({
        level: levels.URGENT
        , title: 'Snoozing high alarm since there is enough IOB'
        , message: [sbx.propertyLine('bwp'), sbx.propertyLine('iob')].join('\n')
        , lengthMills: settings.snoozeLength
        , debug: prop
      });
    } else if (prop.scaledSGV > sbx.data.profile.getHighBGTarget(sbx.time) && prop.bolusEstimate > settings.warnBWP) {
      var level = prop.bolusEstimate > settings.urgentBWP ? levels.URGENT : levels.WARN;
      var levelLabel = levels.toDisplay(level);
      var sound = level === levels.URGENT ? 'updown' : 'bike';

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
    var high = ar2EventType === 'high' || prop.scaledSGV >= sbx.scaleMgdl(sbx.settings.thresholds.bgTargetTop);

    return high && prop.bolusEstimate < settings.snoozeBWP;
  };


  bwp.updateVisualisation = function updateVisualisation (sbx) {

    var prop = sbx.properties.bwp;

    var info = [];
    pushInfo(prop, info, sbx);

    var value;
    if (prop && prop.bolusEstimateDisplay >= 0) {
      value = prop.bolusEstimateDisplay + 'U';
    } else if (prop && prop.bolusEstimateDisplay < 0) {
      value = '< 0U';
    }

    sbx.pluginBase.updatePillText(bwp, {
      value: value
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

    var scaled = sbx.lastScaledSGV();

    results.scaledSGV = scaled;

    var errors = checkMissingInfo(sbx);

    if (errors && errors.length > 0) {
      results.errors = errors;
      return results;
    }

    var profile = sbx.data.profile;
    var iob = results.iob = sbx.properties.iob.iob;

    results.effect = iob * profile.getSensitivity(sbx.time);
    results.outcome = scaled - results.effect;
    var delta = 0;

    var recentCarbs = _.findLast(sbx.data.treatments, function eachTreatment (treatment) {
      return treatment.mills <= sbx.time &&
        sbx.time - treatment.mills < times.mins(60).msecs &&
        treatment.carbs > 0;
    });

    results.recentCarbs = recentCarbs;

    var target_high = profile.getHighBGTarget(sbx.time);
    var sens = profile.getSensitivity(sbx.time);

    if (results.outcome > target_high) {
      delta = results.outcome - target_high;
      results.bolusEstimate = delta / sens;
      results.aimTarget = target_high;
      results.aimTargetString = 'above high';
    }

    var target_low = profile.getLowBGTarget(sbx.time);

    results.belowLowTarget = false;
    if (scaled < target_low) {
      results.belowLowTarget = true;
    }

    if (results.outcome < target_low) {
      delta = Math.abs(results.outcome - target_low);
      results.bolusEstimate = delta / sens * -1;
      results.aimTarget = target_low;
      results.aimTargetString = 'below low';
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
    , snoozeLength: (sbx.extendedSettings.snoozeMins && Number(sbx.extendedSettings.snoozeMins) * 60 * 1000) || times.mins(10).msecs
    };
  }

  return bwp;

}

function isSGVOk (sbx) {
  var lastSGVEntry = sbx.lastSGVEntry();
  return lastSGVEntry && lastSGVEntry.mgdl >= 39 && sbx.isCurrent(lastSGVEntry);
}

function profileFieldsMissing (sbx) {
  return !sbx.data.profile.getSensitivity(sbx.time)
    || !sbx.data.profile.getHighBGTarget(sbx.time)
    || !sbx.data.profile.getLowBGTarget(sbx.time);
}

function pushInfo(prop, info, sbx) {
  if (prop && prop.errors) {
    info.push({label: 'Notice', value: 'required info missing'});
    _.each(prop.errors, function pushError (error) {
      info.push({label: '  • ', value: error});
    });
  } else if (prop) {
    info.push({label: 'Insulin on Board', value: prop.displayIOB + 'U'});
    info.push({label: 'Current target', value: 'Low: '+sbx.data.profile.getLowBGTarget(sbx.time) + ' High: ' + sbx.data.profile.getHighBGTarget(sbx.time)});
    info.push({label: 'Sensitivity', value: '-' + sbx.data.profile.getSensitivity(sbx.time) + ' ' + sbx.settings.units + '/U'});
    info.push({label: 'Expected effect', value: prop.displayIOB + ' x -' + sbx.data.profile.getSensitivity(sbx.time) + ' = -' + prop.effectDisplay + ' ' + sbx.settings.units});
    info.push({label: 'Expected outcome', value: sbx.lastScaledSGV() + '-' + prop.effectDisplay + ' = ' + prop.outcomeDisplay + ' ' + sbx.settings.units});
    if (prop.bolusEstimateDisplay < 0) {
      info.unshift({label: '---------', value: ''});
      var carbEquivalent = Math.ceil(Math.abs(sbx.data.profile.getCarbRatio() * prop.bolusEstimateDisplay));
      info.unshift({label: 'Carb Equivalent', value: prop.bolusEstimateDisplay + 'U * ' + sbx.data.profile.getCarbRatio() + ' = ' + carbEquivalent + 'g'});
      info.unshift({label: 'Current Carb Ratio', value: '1U / ' + sbx.data.profile.getCarbRatio() + ' g'});
      
      if (prop.recentCarbs) {
        info.unshift({
          label: 'Recent carbs'
          , value: prop.recentCarbs.carbs + 'g @ ' + moment(prop.recentCarbs.mills).format('LT')});
      }
      
      if (!prop.belowLowTarget) {
        info.unshift({
          label: '-BWP'
          , value: 'Excess insulin equivalent ' + prop.bolusEstimateDisplay + 'U more than needed to reach low target, not accounting for carbs'});
      }

      if (prop.belowLowTarget) {
        if (prop.iob > 0) {
          info.unshift({
            label: '-BWP'
            , value: 'Excess insulin equivalent ' + prop.bolusEstimateDisplay + 'U more than needed to reach low target, MAKE SURE IOB IS COVERED BY CARBS'});
        } else {
          info.unshift({
            label: '-BWP'
            , value: prop.bolusEstimateDisplay + 'U reduction needed in active insulin to reach low target, too much basal?'});
        }
      }
    }
  } else {
    info.push({label: 'Notice', value: 'required info missing'});
  }

  pushTempBasalAdjustments(prop, info, sbx);
}

function pushTempBasalAdjustments(prop, info, sbx) {
  if (prop && prop.tempBasalAdjustment) {
    var carbsOrBolusMessage = 'too large adjustment needed, give carbs?';
    var sign = '';
    if (prop.tempBasalAdjustment.thirtymin > 100) {
      carbsOrBolusMessage = 'too large adjustment needed, give bolus?';
      sign = '+';
    }

    info.push({label: '---------', value: ''});
    if (prop.aimTarget) {
      info.push({label: 'Projection ' + prop.aimTargetString +' target', value: 'aiming at ' + prop.aimTarget + ' ' + sbx.settings.units});
    }
    info.push({label: 'Current basal', value: sbx.data.profile.getBasal(sbx.time)});
    info.push({label: 'Basal change to account for ' + prop.bolusEstimateDisplay + ':', value: ''});

    if (prop.tempBasalAdjustment.thirtymin >= 0 && prop.tempBasalAdjustment.thirtymin <= 200) {
      info.push({label: '30m temp basal', value: '' + prop.tempBasalAdjustment.thirtymin + '% (' + sign + (prop.tempBasalAdjustment.thirtymin - 100) + '%)'});
    } else {
      info.push({label: '30m temp basal', value: carbsOrBolusMessage});
    }
    if (prop.tempBasalAdjustment.onehour >= 0 && prop.tempBasalAdjustment.onehour <= 200) {
      info.push({label: '1h temp basal', value: '' + prop.tempBasalAdjustment.onehour + '% (' + sign + (prop.tempBasalAdjustment.onehour - 100) + '%)'});
    } else {
      info.push({label: '1h temp basal', value: carbsOrBolusMessage});
    }
  }
}

module.exports = init;