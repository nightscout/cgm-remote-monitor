'use strict';

var _ = require('lodash')
  , moment = require('moment')
  , times = require('../times');

function init(ctx) {
  var translate = ctx.language.translate;
  var utils = require('../utils')(ctx);
  
  var activity = {
    name: 'activity'
    , label: 'Activity'
    , pluginType: 'pill-major'
  };

  activity.RECENCY_THRESHOLD = times.mins(30).msecs;

  activity.setProperties = function setProperties(sbx) {
    sbx.offerProperty('activity', function setACTIVITY ( ) {
      return activity.calcTotal(sbx.data.treatments, sbx.data.devicestatus, sbx.data.profile, sbx.time);
    });
  };

  activity.calcTotal = function calcTotal(treatments, devicestatus, profile, time, spec_profile) {
    if (time === undefined) {
      time = Date.now();
    }

    var result = activity.lastACTIVITYDeviceStatus(devicestatus, time);
    
    var treatmentResult = (treatments !== undefined && treatments.length) ? activity.fromTreatments(treatments, profile, time, spec_profile) : {};

    if (_.isEmpty(result)) {
      result = treatmentResult;
    } else if (treatmentResult.activity) {
      result.treatmentActivity = +(Math.round(treatmentResult.activity + "e+3")  + "e-3");
    }
    if (result.activity) result.activity = +(Math.round(result.activity + "e+3")  + "e-3");
    return addDisplay(result);
  };

  function addDisplay(activity) {
    if (_.isEmpty(activity) || activity.activity === undefined) {
      return {};
    }
    var display = utils.toFixed(activity.activity);
    return _.merge(activity, {
      display: display
      , displayLine: 'ACTIVITY: ' + display
    });
  }

  activity.isDeviceStatusAvailable = function isDeviceStatusAvailable (devicestatus) {

    return _.chain(devicestatus)
        .map(activity.fromDeviceStatus)
        .reject(_.isEmpty)
        .value()
        .length > 0;
  };

  activity.lastACTIVITYDeviceStatus = function lastACTIVITYDeviceStatus(devicestatus, time) {
    if (time && time.getTime) {
      time = time.getTime();
    }
    var futureMills = time + times.mins(5).msecs; //allow for clocks to be a little off
    var recentMills = time - activity.RECENCY_THRESHOLD;

    // All ACTIVITIEs
    var activitys = _.chain(devicestatus)
      .filter(function (activityStatus) {
        return activityStatus.mills <= futureMills && activityStatus.mills >= recentMills;
      })
      .map(activity.fromDeviceStatus)
      .reject(_.isEmpty)
      .sortBy('mills');

    // Loop ACTIVITIEs 
    var loopACTIVITIEs = activitys.filter(function (activityStatus) {
      return activityStatus.source === 'Loop';
    });

    // Loop uploads both Loop ACTIVITY and pump-reported ACTIVITY, prioritize Loop ACTIVITY if available
    return loopACTIVITIEs.last().value() || activitys.last().value();
  };

  activity.ACTIVITYDeviceStatusesInTimeRange = function ACTIVITYDeviceStatusesInTimeRange (devicestatus, from, to) {

    return _.chain(devicestatus)
      .filter(function (activityStatus) {
        return activityStatus.mills > from && activityStatus.mills < to;
      })
      .map(activity.fromDeviceStatus)
      .reject(_.isEmpty)
      .sortBy('mills')
      .value();
  };

  activity.fromDeviceStatus = function fromDeviceStatus(devicestatusEntry) {
    var activityOpenAPS = _.get(devicestatusEntry, 'openaps.iob');
    var activityLoop = _.get(devicestatusEntry, 'loop.activity');
    var activityPump = _.get(devicestatusEntry, 'pump.activity');

    if (activityOpenAPS != undefined) {

      //hacks to support AMA activity array with time fields instead of timestamp fields
      activityOpenAPS = _.isArray(activityOpenAPS) ? activityOpenAPS[0] : activityOpenAPS;

      // array could still be empty, handle as null
      if (_.isEmpty(activityOpenAPS)) {
        return {};
      }

      if (activityOpenAPS.time) {
        activityOpenAPS.timestamp = activityOpenAPS.time;
      }

      return {
        activity: activityOpenAPS.activity
        , source: 'OpenAPS'
        , device: devicestatusEntry.device
        , mills: moment(activityOpenAPS.timestamp).valueOf( )
      };
    } else if (_.isObject(activityLoop)) {
      return {
        activity: activityLoop.activity
        , source: 'Loop'
        , device: devicestatusEntry.device
        , mills: moment(activityLoop.timestamp).valueOf( )
      };
    } else if (_.isObject(activityPump)) {
      return {
        activity: activityPump.activity || activityPump.bolusactivity
        , source: devicestatusEntry.connect !== undefined ? 'MM Connect' : undefined
        , device: devicestatusEntry.device
        , mills: devicestatusEntry.mills
      };
    } else {
      return {};
    }
  };

  activity.fromTreatments = function fromTreatments(treatments, profile, time, spec_profile) {
    var totalActivity = 0;

    var lastBolus = null;

    _.each(treatments, function eachTreatment(treatment) {
      if (treatment.mills <= time) {
        var tACTIVITY = activity.calcTreatment(treatment, profile, time, spec_profile);
        if (tACTIVITY.activityContrib > 0) {
          lastBolus = treatment;
        }
        // units: BG (mg/dL or mmol/L)
        if (tACTIVITY && tACTIVITY.activityContrib) { totalActivity += tACTIVITY.activityContrib; }
      }
    });

    return {
      iob: 0
      , activity: totalActivity
      , lastBolus: lastBolus
      , source: translate('Care Portal')
    };
  };

  activity.calcTreatment = function calcTreatment(treatment, profile, time, spec_profile) {

    var dia = 3
      , sens = 0;

    if (profile !== undefined) {
      dia = profile.getDIA(time, spec_profile) || 3;
      sens = profile.getSensitivity(time, spec_profile);
    }

    var scaleFactor = 3.0 / dia
      , peak = 75
      , result = {
          activityContrib: 0
        };

    if (treatment.insulin) {
      var bolusTime = treatment.mills;
      var minAgo = scaleFactor * (time - bolusTime) / 1000 / 60;

      if (minAgo < peak) {
        var x1 = minAgo / 5 + 1;
        result.activityContrib = treatment.insulin * (1 - 0.001852 * x1 * x1 + 0.001852 * x1);
        // units: BG (mg/dL)  = (BG/U) *    U insulin     * scalar
        result.activityContrib = sens * treatment.insulin * (2 / dia / 60 / peak) * minAgo;

      } else if (minAgo < 180) {
        var x2 = (minAgo - 75) / 5;
        result.activityContrib = treatment.insulin * (0.001323 * x2 * x2 - 0.054233 * x2 + 0.55556);
        result.activityContrib = sens * treatment.insulin * (2 / dia / 60 - (minAgo - peak) * 2 / dia / 60 / (60 * 3 - peak));
      }

    }

    return result;

  };

  activity.updateVisualisation = function updateVisualisation(sbx) {
    var info = [];

    var prop = sbx.properties.activity;

    if (prop.lastBolus) {
      var when = new Date(prop.lastBolus.mills).toLocaleTimeString();
      var amount = sbx.roundInsulinForDisplayFormat(Number(prop.lastBolus.insulin)) + 'U';
      info.push({ label: translate('Last Bolus'), value: amount + ' @ ' + when });
    }
    if (prop.basalactivity !== undefined) {
      info.push({ label: translate('Basal ACTIVITY'), value: prop.basalactivity.toFixed(2) });
    }
    if (prop.source !== undefined) {
      info.push({ label: translate('Source'), value: prop.source });
    }
    if (prop.device !== undefined) {
      info.push({ label: translate('Device'), value: prop.device });
    }

    if (prop.treatmentActivity !== undefined) {
      info.push({label: '------------', value: ''});
      info.push({ label: translate('Careportal ACTIVITY'), value: prop.treatmentActivity.toFixed(2) });
    }

    var value = (prop.display !== undefined ? sbx.roundInsulinForDisplayFormat(prop.display) : '---') + 'U';

    sbx.pluginBase.updatePillText(activity, {
      value: value
      , label: translate('ACTIVITY')
      , info: info
    });

  };

  function virtAsstACTIVITYIntentHandler (callback, slots, sbx) {

    var message = translate('virtAsstActivityIntent', {
      params: [
          getActivity(sbx)
      ]
    });
    callback(translate('virtAsstTitleCurrentACTIVITY'), message);
  }

  function virtAsstACTIVITYRollupHandler (slots, sbx, callback) {
    var activity = getActivity(sbx);
    var message = translate('virtAsstActivity', {
      params: [activity]
    });
    callback(null, {results: message, priority: 2});
  }

  function getActivity(sbx) {
    var activity = _.get(sbx, 'properties.activity.activity');
    if (activity !== 0) {
      return translate('virtAsstActivityUnits', {
        params: [
            utils.toFixed(activity)
        ]
      });
    }
    return translate('virtAsstNoInsulin');
  }

  activity.virtAsst = {
    rollupHandlers: [{
      rollupGroup: 'Status'
      , rollupName: 'current activity'
      , rollupHandler: virtAsstACTIVITYRollupHandler
    }]
    , intentHandlers: [{
      intent: 'MetricNow'
      , metrics: ['activity', 'insulin on board']
      , intentHandler: virtAsstACTIVITYIntentHandler
    }]
  };

  return activity;

}

module.exports = init;
