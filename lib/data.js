'use strict';

var _ = require('lodash');
var async = require('async');
var ObjectID = require('mongodb').ObjectID;

function uniq(a) {
  var seen = {};
  return a.filter(function (item) {
    return seen.hasOwnProperty(item.x) ? false : (seen[item.x] = true);
  });
}

function init(env, ctx) {

  var data = {
    sgvs: []
    , treatments: []
    , mbgs: []
    , cals: []
    , profiles: []
    , devicestatus: {}
    , lastUpdated: 0
  };

  var ONE_DAY = 86400000
    , TWO_DAYS = 172800000;


  var dir2Char = {
    'NONE': '&#8700;',
    'DoubleUp': '&#8648;',
    'SingleUp': '&#8593;',
    'FortyFiveUp': '&#8599;',
    'Flat': '&#8594;',
    'FortyFiveDown': '&#8600;',
    'SingleDown': '&#8595;',
    'DoubleDown': '&#8650;',
    'NOT COMPUTABLE': '-',
    'RATE OUT OF RANGE': '&#8622;'
  };

  function directionToChar(direction) {
    return dir2Char[direction] || '-';
  }

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

    var earliest_data = data.lastUpdated - TWO_DAYS;
    var treatment_earliest_data = data.lastUpdated - (ONE_DAY * 8);

    function sort(values) {
      values.sort(function sorter(a, b) {
        return a.x - b.x;
      });
    }

    async.parallel({
      entries: function (callback) {
        var q = {find: {date: {$gte: earliest_data}}};
        ctx.entries.list(q, function (err, results) {
          if (!err && results) {
            var mbgs = [];
            var sgvs = [];
            results.forEach(function (element) {
              if (element) {
                if (element.mbg) {
                  mbgs.push({
                    y: element.mbg, x: element.date, device: element.device
                  });
                } else if (element.sgv) {
                  sgvs.push({
                    y: element.sgv, x: element.date, device: element.device, direction: directionToChar(element.direction), filtered: element.filtered, unfiltered: element.unfiltered, noise: element.noise, rssi: element.rssi
                  });
                }
              }
            });
            //FIXME: sort in mongo
            sort(mbgs); uniq(mbgs);
            sort(sgvs); uniq(sgvs);
            data.mbgs = mbgs;
            data.sgvs = sgvs;
          }
          callback();
        });
      }, cal: function (callback) {
        //FIXME: date $gte?????
        var cq = {count: 1, find: {type: 'cal'}};
        ctx.entries.list(cq, function (err, results) {
          if (!err && results) {
            var cals = [];
            results.forEach(function (element) {
              if (element) {
                cals.push({
                  x: element.date, scale: element.scale, intercept: element.intercept, slope: element.slope
                });
              }
            });
            data.cals = cals;
          }
          callback();
        });
      }, treatments: function (callback) {
        var tq = {find: {created_at: {$gte: new Date(treatment_earliest_data).toISOString()}}};
        ctx.treatments.list(tq, function (err, results) {
          if (!err && results) {
            var treatments = results.map(function (treatment) {
              treatment.created_at = new Date(treatment.created_at).getTime();
              //TODO: #CleanUpDataModel, some code expects x everywhere
              treatment.x = treatment.created_at;
              return treatment;
            });

            //FIXME: sort in mongo
            treatments.sort(function (a, b) {
              return a.created_at - b.created_at;
            });

            data.treatments = treatments;
          }

          callback();
        });
      }, profile: function (callback) {
        ctx.profile.list(function (err, results) {
          if (!err && results) {
            // There should be only one document in the profile collection with a DIA.  If there are multiple, use the last one.
            var profiles = [];
            results.forEach(function (element) {
              if (element) {
                if (element.dia) {
                  profiles[0] = element;
                }
              }
            });
            data.profiles = profiles;
          }
          callback();
        });
      }, devicestatus: function (callback) {
        ctx.devicestatus.last(function (err, result) {
          if (!err && result) {
            data.devicestatus.uploaderBattery = result.uploaderBattery;
          }
          callback();
        });
      }
    }, done);

  };

  data.calculateDelta = function calculateDelta(lastData) {
    return data.calculateDeltaBetweenDatasets(lastData,data);
  };
  
  data.calculateDeltaBetweenDatasets = function calculateDeltaBetweenDatasets(oldData,newData) {

    var delta = {'delta': true};
    var changesFound = false;

    // if there's no updates done so far, just return the full set
    if (!oldData.sgvs) { return newData; }

    function nsArrayDiff(oldArray, newArray) {
      var seen = {};
      var l = oldArray.length;
      for (var i = 0; i < l; i++) {
        seen[oldArray[i].x] = true;
      }
      var result = [];
      l = newArray.length;
      for (var j = 0; j < l; j++) {
        if (!seen.hasOwnProperty(newArray[j].x)) {
          result.push(newArray[j]);
        }
      }
      return result;
    }

    function sort(values) {
      values.sort(function sorter(a, b) {
        return a.x - b.x;
      });
    }

    delta.lastUpdated = newData.lastUpdated;

    // array compression
    var compressibleArrays = ['sgvs', 'treatments', 'mbgs', 'cals'];

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
          var deltaData = nsArrayDiff(oldData[a], newData[a]);
          if (deltaData.length > 0) {
            console.log('delta changes found on', a);
            changesFound = true;
            sort(deltaData);
            delta[a] = deltaData;
          }
        }
      }
    }

    // objects
    var skippableObjects = ['profiles', 'devicestatus'];

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

    if (changesFound) { return delta; }
    return newData;
  };


  return data;

}

module.exports = init;