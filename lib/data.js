'use strict';

var _ = require('lodash');
var async = require('async');
var ObjectID = require('mongodb').ObjectID;
var rawbg = require('../lib/plugins/rawbg')();

var ONE_DAY = 86400000
  , TWO_DAYS = 172800000;

function uniq(a) {
  var seen = {};
  return a.filter(function (item) {
    return seen.hasOwnProperty(item.mills) ? false : (seen[item.mills] = true);
  });
}

function init(env, ctx) {

  var data = {
    sgvs: []
    , treatments: []
    , mbgs: []
    , cals: []
    , profiles: []
    , devicestatus: []
    , lastUpdated: 0
  };

  data.clone = function clone() {
    return _.cloneDeep(data, function (value) {
      //special handling of mongo ObjectID's
      //see https://github.com/lodash/lodash/issues/602#issuecomment-47414964
      if (value instanceof ObjectID) {
        return value.toString();
      }
    });
  };

  data.update = function update(done) {

    console.log('running data.update');
    data.lastUpdated = Date.now();

    function loadComplete (err, result) {
      data.treatments = _.uniq(data.treatments, false, function (item) { return item._id.toString(); });
      //sort treatments so the last is the most recent
      data.treatments = _.sortBy(data.treatments, function (item) { return item.mills; });
      data.updateTreatmentDisplayBGs();
      if (err) {
        console.error(err);
      }
      done(err, result);
    }

    // clear treatments, we're going to merge from more queries
    data.treatments = [];
    
    async.parallel([
      loadEntries.bind(null, data, ctx)
      , loadTreatments.bind(null, data, ctx)
      , loadProfileSwitchTreatments.bind(null, data, ctx)
      , loadSensorTreatments.bind(null, data, ctx)
      , loadProfile.bind(null, data, ctx)
      , loadDeviceStatus.bind(null, data, env, ctx)
    ], loadComplete);

  };

  data.calculateDelta = function calculateDelta(lastData) {
    return data.calculateDeltaBetweenDatasets(lastData,data);
  };
  
  data.calculateDeltaBetweenDatasets = function calculateDeltaBetweenDatasets(oldData,newData) {

    var delta = {'delta': true};
    var changesFound = false;

    // if there's no updates done so far, just return the full set
    if (!oldData.sgvs) { return newData; }

    function nsArrayTreatments(oldArray, newArray) {
      var result = [];
      
      // check for add, change
      var l = newArray.length;
      var m = oldArray.length;
      var found, founddiff, no, oo, i, j;
      for (i = 0; i < l; i++) {
        no = newArray[i];
        found = false;
        founddiff = false;
        for (j = 0; j < m; j++) {
          oo = oldArray[j];
          no._id = no._id.toString();
          if (no._id === oo._id) {
            found = true;
            if (!_.isEqual(oo, no)) {
              founddiff = true;
            }
            break;
          }
        }
        if (founddiff) {
          var nno = _.cloneDeep(no);
          nno.action = 'update';
          result.push(nno);
        }
        if (!found) {
          result.push(no);
        }
      }
      
      //check for delete
      for (j = 0; j < m; j++) {
        oo = oldArray[j];
        found = false;
        for (i = 0; i < l; i++) {
          no = newArray[i];
          if (no._id === oo._id) {
            found = true;
            break;
          }
        }
        if (!found) {
          result.push({ _id: oo._id, action: 'remove' });
        }
      }

      return result;
    }
    
    function nsArrayDiff(oldArray, newArray) {
      var seen = {};
      var l = oldArray.length;
      for (var i = 0; i < l; i++) {
        seen[oldArray[i].mills] = true;
      }
      var result = [];
      l = newArray.length;
      for (var j = 0; j < l; j++) {
        if (!seen.hasOwnProperty(newArray[j].mills)) {
          result.push(newArray[j]);
        }
      }
      return result;
    }

    function sort(values) {
      values.sort(function sorter(a, b) {
        return a.mills - b.mills;
      });
    }

    function compressArrays(delta, newData) {
      // array compression
      var compressibleArrays = ['sgvs', 'treatments', 'mbgs', 'cals', 'devicestatus'];
      var changesFound = false;

      for (var array in compressibleArrays) {
        if (compressibleArrays.hasOwnProperty(array)) {
          var a = compressibleArrays[array];
          if (newData.hasOwnProperty(a)) {

            // if previous data doesn't have the property (first time delta?), just assign data over
            if (!oldData.hasOwnProperty(a)) {
              delta[a] = newData[a];
              changesFound = true;
              continue;
            }

            // Calculate delta and assign delta over if changes were found
            var deltaData = (a === 'treatments' ? nsArrayTreatments(oldData[a], newData[a]) : nsArrayDiff(oldData[a], newData[a]));
            if (deltaData.length > 0) {
              console.log('delta changes found on', a);
              changesFound = true;
              sort(deltaData);
              delta[a] = deltaData;
            }
          }
        }
      }
      return {'delta': delta, 'changesFound': changesFound};
    }

    function deleteSkippables(delta,newData) {
      // objects
      var skippableObjects = ['profiles'];
      var changesFound = false;

      for (var object in skippableObjects) {
        if (skippableObjects.hasOwnProperty(object)) {
          var o = skippableObjects[object];
          if (newData.hasOwnProperty(o)) {
            if (JSON.stringify(newData[o]) !== JSON.stringify(oldData[o])) {
              console.log('delta changes found on', o);
              changesFound = true;
              delta[o] = newData[o];
            }
          }
        }
      }
      return {'delta': delta, 'changesFound': changesFound};
    }

    delta.lastUpdated = newData.lastUpdated;

    var compressedDelta = compressArrays(delta, newData);
    delta = compressedDelta.delta;
    if (compressedDelta.changesFound) { changesFound = true; }

    var skippedDelta = deleteSkippables(delta, newData);
    delta = skippedDelta.delta;
    if (skippedDelta.changesFound) { changesFound = true; }   

    if (changesFound) { return delta; }
    return newData;
    
  };

  data.updateTreatmentDisplayBGs = function updateTreatmentDisplayBGs () {
    function updateTreatmentBG(treatment) {

      function mgdlByTime() {

        var withBGs = _.filter(data.sgvs, function(d) {
          return d.mgdl > 39 || env.settings.isEnabled('rawbg');
        });

        var beforeTreatment = _.findLast(withBGs, function (d) {
          return d.mills <= treatment.mills;
        });
        var afterTreatment = _.find(withBGs, function (d) {
          return d.mills >= treatment.mills;
        });

        var mgdlBefore = mgdlValue(beforeTreatment) || calcRaw(beforeTreatment);
        var mgdlAfter = mgdlValue(afterTreatment) || calcRaw(afterTreatment);

        var calcedBG = 0;
        if (mgdlBefore && mgdlAfter) {
          calcedBG = (mgdlBefore + mgdlAfter) / 2;
        } else if (mgdlBefore) {
          calcedBG = mgdlBefore;
        } else if (mgdlAfter) {
          calcedBG = mgdlAfter;
        }

        return calcedBG || 180;
      }

      function mgdlValue (entry) {
        return entry && entry.mgdl >= 39 && Number(entry.mgdl);
      }

      function calcRaw (entry) {
        var raw;
        if (entry && env.settings.isEnabled('rawbg')) {
          var cal = _.last(data.cals);
          if (cal) {
            raw = rawbg.calc(entry, cal);
          }
        }
        return raw;
      }

      //to avoid checking if eventType is null everywhere, just default it here
      treatment.eventType = treatment.eventType || '';

      if (treatment.glucose && isNaN(treatment.glucose)) {
        console.warn('found an invalid glucose value', treatment);
      } else if (treatment.glucose && treatment.units) {
        if (treatment.units === 'mmol') {
          treatment.mmol = Number(treatment.glucose);
        } else {
          treatment.mgdl = Number(treatment.glucose);
        }
      } else if (treatment.glucose) {
        //no units, assume everything is the same
        console.warn('found a glucose value without any units, maybe from an old version?', _.pick(treatment, '_id', 'created_at', 'enteredBy'));
        var units = env.DISPLAY_UNITS === 'mmol' ? 'mmol' : 'mgdl';
        treatment[units] = Number(treatment.glucose);
      } else {
        treatment.mgdl = mgdlByTime();
      }
    }

    _.each(data.treatments, updateTreatmentBG);

  };

  return data;

}

function loadEntries (data, ctx, callback) {
  var q = {
    find: {
      date: {
        $gte: data.lastUpdated - TWO_DAYS
      }
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
      data.mbgs = uniq(mbgs);
      data.sgvs = uniq(sgvs);
      data.cals = uniq(cals);
    }
    callback();
  });
}

function mergeToTreatments (data, results) {
  var treatments = results.map(function (treatment) {
    treatment.mills = new Date(treatment.created_at).getTime();
    
    return treatment;
  });
  data.treatments = _.union(data.treatments, treatments);
}

function loadTreatments (data, ctx, callback) {
  var tq = {
    find: {
      created_at: {
        $gte: new Date(data.lastUpdated - (ONE_DAY * 8)).toISOString()
      }
    }
    , sort: {created_at: 1}
  };

  ctx.treatments.list(tq, function (err, results) {
    if (!err && results) {
      mergeToTreatments(data, results);
    }

    callback();
  });
}

function loadProfileSwitchTreatments (data, ctx, callback) {
  var tq = {
    find: {
      eventType: {
        $eq: 'Profile Switch'
      }
      , created_at: {
        $gte: new Date(data.lastUpdated - (ONE_DAY * 31 * 12)).toISOString()
      }
    }
    , sort: {created_at: -1}
  };

  ctx.treatments.list(tq, function (err, results) {
    if (!err && results) {
      mergeToTreatments(data, results);
    }

    callback();
  });
}

function loadSensorTreatments (data, ctx, callback) {
  var tq = {
    find: {
      eventType: {
        $in: [ 'Sensor Start', 'Sensor Change']
      }
      , created_at: {
        $gte: new Date(data.lastUpdated - (ONE_DAY * 32)).toISOString()
      }
    }
    , sort: {created_at: -1}
  };

  ctx.treatments.list(tq, function (err, results) {
    if (!err && results) {
      mergeToTreatments(data, results);
    }

    callback();
  });
}

function loadProfile (data, ctx, callback) {
  ctx.profile.last(function (err, results) {
    if (!err && results) {
      var profiles = [];
      results.forEach(function (element) {
        if (element) {
            profiles[0] = element;
        }
      });
      data.profiles = profiles;
    }
    callback();
  });
}

function loadDeviceStatus (data, env, ctx, callback) {
  var opts = {
    find: {
      created_at: {
        $gte: new Date(data.lastUpdated - TWO_DAYS).toISOString()
      }
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
      data.devicestatus = _.map(results, function eachStatus (result) {
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
      data.devicestatus = [];
    }
    callback();
  });
}

module.exports = init;