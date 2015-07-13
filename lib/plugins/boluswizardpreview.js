'use strict';

var TIME_10_MINS = 10 * 60 * 1000;
var TIME_15_MINS = 15 * 60 * 1000;

function init() {

  function bwp() {
    return bwp;
  }

  bwp.label = 'Bolus Wizard Preview';
  bwp.pluginType = 'pill-minor';

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

    if (sbx.lastSGV() < 39 || sbx.time - sbx.lastSGVMills() > TIME_15_MINS) {
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

    var sgv = sbx.lastScaledSGV();

    results.lastSGV = sgv;

    var errors = checkMissingInfo(sbx);

    if (errors && errors.length > 0) {
      results.errors = errors;
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
    , snoozeLength: (sbx.extendedSettings.snoozeMins && Number(sbx.extendedSettings.snoozeMins) * 60 * 1000) || TIME_10_MINS
    };
  }

  return bwp();

}

function profileFieldsMissing (sbx) {
  return !sbx.data.profile.getSensitivity(sbx.time)
    || !sbx.data.profile.getHighBGTarget(sbx.time)
    || !sbx.data.profile.getLowBGTarget(sbx.time);
}

function pushInfo(prop, info, sbx) {
  if (prop && prop.errors) {
    info.push({label: 'Notice', value: 'required info missing'});
    _.forEach(prop.errors, function pushError (error) {
      info.push({label: '  • ', value: error});
    });
  } else if (prop) {
    info.push({label: 'Insulin on Board', value: prop.displayIOB + 'U'});
    info.push({label: 'Sensitivity', value: '-' + sbx.data.profile.getSensitivity(sbx.time) + ' ' + sbx.units + '/U'});
    info.push({label: 'Expected effect', value: prop.displayIOB + ' x -' + sbx.data.profile.getSensitivity(sbx.time) + ' = -' + prop.effectDisplay + ' ' + sbx.units});
    info.push({label: 'Expected outcome', value: sbx.lastScaledSGV() + '-' + prop.effectDisplay + ' = ' + prop.outcomeDisplay + ' ' + sbx.units});
    if (prop.bolusEstimateDisplay < 0) {
      info.unshift({label: '-BWP', value: prop.bolusEstimateDisplay + 'U, maybe covered by carbs?'});
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
    info.push({label: 'Current basal', value: sbx.data.profile.getBasal(sbx.time)});
    info.push({label: 'Basal change to account for ' + prop.bolusEstimateDisplay + ':', value: ''});

    if (prop.tempBasalAdjustment.thirtymin > 0 && prop.tempBasalAdjustment.thirtymin < 200) {
      info.push({label: '30m temp basal', value: '' + prop.tempBasalAdjustment.thirtymin + '% (' + sign + (prop.tempBasalAdjustment.thirtymin - 100) + '%)'});
    } else {
      info.push({label: '30m temp basal', value: carbsOrBolusMessage});
    }
    if (prop.tempBasalAdjustment.onehour > 0 && prop.tempBasalAdjustment.onehour < 200) {
      info.push({label: '1h temp basal', value: '' + prop.tempBasalAdjustment.onehour + '% (' + sign + (prop.tempBasalAdjustment.onehour - 100) + '%)'});
    } else {
      info.push({label: '1h temp basal', value: carbsOrBolusMessage});
    }
  }
}

module.exports = init;