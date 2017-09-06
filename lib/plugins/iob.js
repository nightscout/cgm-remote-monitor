'use strict';

var _ = require('lodash')
  , moment = require('moment')
  , times = require('../times')
  , utils = require('../utils')();

function init(ctx) {
  var translate = ctx.language.translate;

  var iob = {
    name: 'iob'
    , label: 'Insulin-on-Board'
    , pluginType: 'pill-major'
  };

  iob.RECENCY_THRESHOLD = times.mins(30).msecs;

  iob.setProperties = function setProperties(sbx) {
    sbx.offerProperty('iob', function setIOB ( ) {
      return iob.calcTotal(sbx.data.treatments, sbx.data.devicestatus, sbx.data.profile, sbx.time);
    });
  };

  iob.calcTotal = function calcTotal(treatments, devicestatus, profile, time, spec_profile) {
    if (time === undefined) {
      time = Date.now();
    }

    var result = iob.lastIOBDeviceStatus(devicestatus, time);
    
    var treatmentResult = (treatments !== undefined && treatments.length) ? iob.fromTreatments(treatments, profile, time, spec_profile) : {};

    if (_.isEmpty(result)) {
      result = treatmentResult;
    } else if (treatmentResult.iob) {
      result.treatmentIob = treatmentResult.iob;
    }

    return addDisplay(result);
  };

  function addDisplay(iob) {
    if (_.isEmpty(iob) || iob.iob === undefined) {
      return {};
    }
    var display = utils.toFixed(iob.iob);
    return _.merge(iob, {
      display: display
      , displayLine: 'IOB: ' + display + 'U'
    });
  }

  iob.lastIOBDeviceStatus = function lastIOBDeviceStatus(devicestatus, time) {
    if (time && time.getTime) {
      time = time.getTime();
    }
    var futureMills = time + times.mins(5).msecs; //allow for clocks to be a little off
    var recentMills = time - iob.RECENCY_THRESHOLD;
    return  _.chain(devicestatus)
      .map(iob.fromDeviceStatus)
      .reject(_.isEmpty)
      .filter(function (iobStatus) {
        return iobStatus.mills <= futureMills && iobStatus.mills >= recentMills;
      })
      .sortBy('mills')
      .last( )
      .value( );
  };

  iob.fromDeviceStatus = function fromDeviceStatus(devicestatusEntry) {
    var iobObj;
    if (_.get(devicestatusEntry, 'openaps.iob') !== undefined) {

      //hacks to support AMA iob array with time fields instead of timestamp fields
      iobObj = _.isArray(devicestatusEntry.openaps.iob) ? devicestatusEntry.openaps.iob[0] : devicestatusEntry.openaps.iob;

      // array could still be empty, handle as null
      if (_.isEmpty(iobObj)) {
        return {};
      }

      if (iobObj.time) {
        iobObj.timestamp = iobObj.time;
      }

      return {
        iob: iobObj.iob
        , basaliob: iobObj.basaliob
        , activity: iobObj.activity
        , source: 'OpenAPS'
        , device: devicestatusEntry.device
        , mills: moment(iobObj.timestamp).valueOf( )
      };
    } else if (_.get(devicestatusEntry, 'loop.iob') !== undefined) {
      iobObj = devicestatusEntry.loop.iob;
      return {
        iob: iobObj.iob
        , source: 'Loop'
        , device: devicestatusEntry.device
        , mills: moment(iobObj.timestamp).valueOf( )
      };
    } else if (_.get(devicestatusEntry, 'pump.iob') !== undefined) {
      iobObj = devicestatusEntry.pump.iob.iob;
      iobObj = iobObj !== undefined ? iobObj : devicestatusEntry.pump.iob.bolusiob;
      return {
        iob: iobObj
        , source: devicestatusEntry.connect !== undefined ? 'MM Connect' : undefined
        , device: devicestatusEntry.device
        , mills: devicestatusEntry.mills
      };
    } else {
      return {};
    }
  };

  iob.fromTreatments = function fromTreatments(treatments, profile, time, spec_profile) {
    var totalIOB = 0
      , totalActivity = 0;

    var lastBolus = null;

    _.each(treatments, function eachTreatment(treatment) {
      if (treatment.mills <= time) {
        var tIOB = iob.calcTreatment(treatment, profile, time, spec_profile);
        if (tIOB.iobContrib > 0) {
          lastBolus = treatment;
        }
        if (tIOB && tIOB.iobContrib) { totalIOB += tIOB.iobContrib; }
        // units: BG (mg/dL or mmol/L)
        if (tIOB && tIOB.activityContrib) { totalActivity += tIOB.activityContrib; }
      }
    });

    return {
      iob: totalIOB
      , activity: totalActivity
      , lastBolus: lastBolus
      , source: translate('Care Portal')
    };
  };

  iob.calcTreatment = function calcTreatment(treatment, profile, time, spec_profile) {

    var dia = 3
      , sens = 0;

    if (profile !== undefined) {
      dia = profile.getDIA(time, spec_profile) || 3;
      sens = profile.getSensitivity(time, spec_profile);
    }

    var scaleFactor = 3.0 / dia
      , peak = 75
      , result = {
          iobContrib: 0
          , activityContrib: 0
        };

    if (treatment.insulin) {
      var bolusTime = treatment.mills;
      var minAgo = scaleFactor * (time - bolusTime) / 1000 / 60;

      if (minAgo < peak) {
        var x1 = minAgo / 5 + 1;
        result.iobContrib = treatment.insulin * (1 - 0.001852 * x1 * x1 + 0.001852 * x1);
        // units: BG (mg/dL)  = (BG/U) *    U insulin     * scalar
        result.activityContrib = sens * treatment.insulin * (2 / dia / 60 / peak) * minAgo;

      } else if (minAgo < 180) {
        var x2 = (minAgo - 75) / 5;
        result.iobContrib = treatment.insulin * (0.001323 * x2 * x2 - 0.054233 * x2 + 0.55556);
        result.activityContrib = sens * treatment.insulin * (2 / dia / 60 - (minAgo - peak) * 2 / dia / 60 / (60 * dia - peak));
      }

    }

    return result;

  };

  iob.updateVisualisation = function updateVisualisation(sbx) {
    var info = [];

    var prop = sbx.properties.iob;

    if (prop.lastBolus) {
      var when = new Date(prop.lastBolus.mills).toLocaleTimeString();
      var amount = sbx.roundInsulinForDisplayFormat(Number(prop.lastBolus.insulin)) + 'U';
      info.push({ label: translate('Last Bolus'), value: amount + ' @ ' + when });
    }
    if (prop.basaliob !== undefined) {
      info.push({ label: translate('Basal IOB'), value: prop.basaliob.toFixed(2) });
    }
    if (prop.source !== undefined) {
      info.push({ label: translate('Source'), value: prop.source });
    }
    if (prop.device !== undefined) {
      info.push({ label: translate('Device'), value: prop.device });
    }

    if (prop.treatmentIob !== undefined) {
      info.push({label: '------------', value: ''});
      info.push({ label: translate('Careportal IOB'), value: prop.treatmentIob.toFixed(2) });
    }

    var value = (prop.display !== undefined ? sbx.roundInsulinForDisplayFormat(prop.display) : '---') + 'U';

    sbx.pluginBase.updatePillText(iob, {
      value: value
      , label: translate('IOB')
      , info: info
    });

  };

  return iob;

}

module.exports = init;
