'use strict';

var _ = require('lodash');
var async = require('async');
var times = require('../times');
var fitTreatmentsToBGCurve = require('./treatmenttocurve');

var ONE_DAY = 86400000
  , TWO_DAYS = 172800000;

function uniq(a) {
  var seen = {};
  return a.filter(function (item) {
    return seen.hasOwnProperty(item.mills) ? false : (seen[item.mills] = true);
  });
}

function init(env, ctx) {

  var dataloader = { };

  dataloader.update = function update(ddata, opts, done) {
    if (opts && done == null && opts.call) {
      done = opts;
      opts = { lastUpdated: Date.now( ), frame: false };
    }

    if (opts.frame) {
      ddata.page = {
        frame: true
        , after: opts.lastUpdated
        // , before: opts.
      };
    }
    ddata.lastUpdated = opts.lastUpdated;
    // console.log('LOOKING SINCE', (new Date(ddata.lastUpdated)));

    function loadComplete (err, result) {
      ddata.treatments = _.uniq(ddata.treatments, false, function (item) { return item._id.toString(); });
      //sort treatments so the last is the most recent
      ddata.treatments = _.sortBy(ddata.treatments, function (item) { return item.mills; });
      fitTreatmentsToBGCurve(ddata, env, ctx);
      if (err) {
        console.error(err);
      }
      ddata.processTreatments(true);

      var counts = [];
      _.forIn(ddata, function each (value, key) {
        if (_.isArray(value) && value.length > 0) {
          counts.push(key + ':' + value.length);
        }
      });

      console.info('Load Complete:\n\t', counts.join(', '));

      done(err, result);
    }

    // clear treatments, we're going to merge from more queries
    ddata.treatments = [];

    async.parallel([
      loadEntries.bind(null, ddata, ctx)
      , loadTreatments.bind(null, ddata, ctx)
      , loadProfileSwitchTreatments.bind(null, ddata, ctx)
      , loadSensorAndInsulinTreatments.bind(null, ddata, ctx)
      , loadProfile.bind(null, ddata, ctx)
      , loadDeviceStatus.bind(null, ddata, env, ctx)
    ], loadComplete);

  };

  return dataloader;

}

function loadEntries (ddata, ctx, callback) {
  var dateRange = {
    $gte: ddata.lastUpdated - TWO_DAYS
  };
  if (ddata.page && ddata.page.frame) {
    dateRange['$lte'] = ddata.lastUpdated;
  }
  var q = {
    find: {
      date: dateRange
    }
    , sort: {date: 1}
  };

  ctx.entries.list(q, function (err, results) {
    if (!err && results) {
      var mbgs = [];
      var sgvs = [];
      var cals = [];
      results.forEach(function (element) {
        if (element) {
          if (element.mbg) {
            mbgs.push({
              mgdl: Number(element.mbg), mills: element.date, device: element.device
            });
          } else if (element.sgv) {
            sgvs.push({
              mgdl: Number(element.sgv), mills: element.date, device: element.device, direction: element.direction, filtered: element.filtered, unfiltered: element.unfiltered, noise: element.noise, rssi: element.rssi
            });
          } else if (element.type === 'cal') {
            cals.push({
              mills: element.date, scale: element.scale, intercept: element.intercept, slope: element.slope
            });
          }
        }
      });

      //stop using uniq for SGVs since we use buckets, also enables more detailed monitoring
      ddata.sgvs = sgvs;

      ddata.mbgs = uniq(mbgs);
      ddata.cals = uniq(cals);
    }
    callback();
  });
}

function mergeToTreatments (ddata, results) {
  var filtered = _.filter(results, function hasId (treatment) {
    return !_.isEmpty(treatment._id);
  });

  var treatments = _.map(filtered, function update (treatment) {
    treatment.mills = new Date(treatment.created_at).getTime();
    return treatment;
  });

  //filter out temps older than a day and an hour ago since we don't display them
  var oldestAgo = ddata.lastUpdated - TWO_DAYS - times.hour().msecs;
  treatments = _.filter(treatments, function noOldTemps (treatment) {
    return !treatment.eventType || treatment.eventType.indexOf('Temp Basal') === -1 || treatment.mills > oldestAgo;
  });

  ddata.treatments = _.unionWith(ddata.treatments, treatments, function (a, b) {
    return a._id.toString() == b._id.toString();
  });
}

function loadTreatments (ddata, ctx, callback) {
  var dateRange = {
    $gte: new Date(ddata.lastUpdated - (ONE_DAY * 8)).toISOString()
  };
  if (ddata.page && ddata.page.frame) {
    dateRange['$lte'] = new Date(ddata.lastUpdated).toISOString( );
  }
  var tq = {
    find: {
      created_at: dateRange
    }
    , sort: {created_at: 1}
  };

  console.log('searching treatments q', tq);
  ctx.treatments.list(tq, function (err, results) {
    if (!err && results) {
      mergeToTreatments(ddata, results);
    }

    callback();
  });
}

function loadProfileSwitchTreatments (ddata, ctx, callback) {
  var dateRange = {
    $gte: new Date(ddata.lastUpdated - (ONE_DAY * 31 * 12)).toISOString()
  };

  if (ddata.page && ddata.page.frame) {
    dateRange['$lte'] = new Date(ddata.lastUpdated).toISOString( );
  }

  var tq = {
    find: {
      eventType: 'Profile Switch'
      , created_at: dateRange
    }
    , sort: {created_at: -1}
  };

  ctx.treatments.list(tq, function (err, results) {
    if (!err && results) {
      mergeToTreatments(ddata, results);
    }

    // Store last profile switch
    if (results) {
      ddata.lastProfileFromSwitch = null;
      var now = new Date().getTime();
      for (var p = 0; p < results.length; p++ ) {
        var pdate = new Date(results[p].created_at).getTime();
        if (pdate < now) {
          ddata.lastProfileFromSwitch = results[p].profile;
          break;
        }
      }
    }

    callback();
  });
}

function loadSensorAndInsulinTreatments (ddata, ctx, callback) {
  var dateRange = {
    $gte: new Date(ddata.lastUpdated - (ONE_DAY * 32)).toISOString()
  };

  if (ddata.page && ddata.page.frame) {
    dateRange['$lte'] = new Date(ddata.lastUpdated).toISOString( );
  }

  var tq = {
    find: {
      eventType: {
        $in: [ 'Sensor Start', 'Sensor Change', 'Insulin Change', 'Pump Battery Change']
      }
      , created_at: dateRange
    }
    , sort: {created_at: -1}
  };

  ctx.treatments.list(tq, function (err, results) {
    if (!err && results) {
      mergeToTreatments(ddata, results);
    }

    callback();
  });
}

function loadProfile (ddata, ctx, callback) {
  ctx.profile.last(function (err, results) {
    if (!err && results) {
      var profiles = [];
      results.forEach(function (element) {
        if (element) {
            profiles[0] = element;
        }
      });
      ddata.profiles = profiles;
    }
    callback();
  });
}

function loadDeviceStatus (ddata, env, ctx, callback) {
  var dateRange = {
    $gte: new Date(ddata.lastUpdated - ONE_DAY).toISOString()
  };
  if (ddata.page && ddata.page.frame) {
    dateRange['$lte'] = new Date(ddata.lastUpdated).toISOString( );
  }
  var opts = {
    find: {
      created_at: dateRange
    }
    , sort: {created_at: -1}
  };

  if (env.extendedSettings.devicestatus && env.extendedSettings.devicestatus.advanced) {
    //not adding count: 1 restriction
  } else {
    opts.count = 1;
  }

  ctx.devicestatus.list(opts, function (err, results) {
    if (!err && results) {
      ddata.devicestatus = _.map(results, function eachStatus (result) {
        result.mills = new Date(result.created_at).getTime();
        if ('uploaderBattery' in result) {
          result.uploader = {
            battery: result.uploaderBattery
          };
          delete result.uploaderBattery;
        }
        return result;
      }).reverse();
    } else {
      ddata.devicestatus = [];
    }
    callback();
  });
}

module.exports = init;
