'use strict';

var _ = require('lodash');
var async = require('async');
var utils = require('./utils')();
var ObjectID = require('mongodb').ObjectID;

function uniq(a) {
  var seen = {};
  return a.filter(function(item) {
    return seen.hasOwnProperty(item.x) ? false : (seen[item.x] = true);
  });
}

function init (env, ctx) {

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

  data.clone = function clone ( ) {
    return _.cloneDeep(data, function (value) {
      //special handling of mongo ObjectID's
      //see https://github.com/lodash/lodash/issues/602#issuecomment-47414964
      if (value instanceof ObjectID) {
        return value.toString();
      }
    });
  };

  data.update = function update (done) {

    console.log('running data.update');
    data.lastUpdated = Date.now();

    var earliest_data = data.lastUpdated - TWO_DAYS;
    var treatment_earliest_data = data.lastUpdated - (ONE_DAY * 8);

    function sort (values) {
      values.sort(function sorter (a, b) {
        return a.x - b.x;
      });
    }

    async.parallel({
      entries: function (callback) {
        var q = { find: {"date": {"$gte": earliest_data}} };
        ctx.entries.list(q, function (err, results) {
          if (!err && results) {
            var mbgs = [];
            var sgvs = [];
            results.forEach(function (element) {
              if (element) {
                if (element.mbg) {
                  mbgs.push({
                    y: element.mbg, x: element.date, d: element.dateString, device: element.device
                  });
                } else if (element.sgv) {
                  sgvs.push({
                    y: element.sgv, x: element.date, d: element.dateString, device: element.device, direction: directionToChar(element.direction), filtered: element.filtered, unfiltered: element.unfiltered, noise: element.noise, rssi: element.rssi
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
        })
      }, cal: function (callback) {
        //FIXME: date $gte?????
        var cq = { count: 1, find: {"type": "cal"} };
        ctx.entries.list(cq, function (err, results) {
          if (!err && results) {
            var cals = [];
            results.forEach(function (element) {
              if (element) {
                cals.push({
                  x: element.date, d: element.dateString, scale: element.scale, intercept: element.intercept, slope: element.slope
                });
              }
            });
            data.cals = cals;
          }
          callback();
        });
      }, treatments: function (callback) {
        var tq = { find: {"created_at": {"$gte": new Date(treatment_earliest_data).toISOString()}} };
        ctx.treatments.list(tq, function (err, results) {
          if (!err && results) {
            var treatments = [];
            treatments = results.map(function (treatment) {
              var timestamp = new Date(treatment.timestamp || treatment.created_at);
              treatment.x = timestamp.getTime();
              return treatment;
            });

            //FIXME: sort in mongo
            treatments.sort(function(a, b) {
              return a.x - b.x;
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
            results.forEach(function (element, index, array) {
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
        })
      }
    }, done);

  };

  data.calculateDelta = function calculateDelta (lastData) {

    var delta = {'delta': true};
    var changesFound = false;

    // if there's no updates done so far, just return the full set
    if (!lastData.sgvs) return data;

    console.log('lastData.sgvs last record time', lastData.sgvs[lastData.sgvs.length-1].x);
    console.log('d.sgvslast record time', data.sgvs[data.sgvs.length-1].x);

    function nsArrayDiff(oldArray, newArray) {
      var seen = {};
      var l = oldArray.length;
      for (var i = 0; i < l; i++) { seen[oldArray[i].x] = true }
      var result = [];
      l = newArray.length;
      for (var j = 0; j < l; j++) { if (!seen.hasOwnProperty(newArray[j].x)) { result.push(newArray[j]); console.log('delta data found'); } }
      return result;
    }

    function sort (values) {
      values.sort(function sorter (a, b) {
        return a.x - b.x;
      });
    }

    var sgvDelta = nsArrayDiff(lastData.sgvs, data.sgvs);

    if (sgvDelta.length > 0) {
      console.log('sgv changes found');
      changesFound = true;
      sort(sgvDelta);
      delta.sgvs = sgvDelta;
    }

    var treatmentDelta = nsArrayDiff(lastData.treatments, data.treatments);

    if (treatmentDelta.length > 0) {
      console.log('treatment changes found');
      changesFound = true;
      sort(treatmentDelta);
      delta.treatments = treatmentDelta;
    }

    var mbgsDelta = nsArrayDiff(lastData.mbgs, data.mbgs);

    if (mbgsDelta.length > 0) {
      console.log('mbgs changes found');
      changesFound = true;
      sort(mbgsDelta);
      delta.mbgs = mbgsDelta;
    }

    var calsDelta = nsArrayDiff(lastData.cals, data.cals);

    if (calsDelta.length > 0) {
      console.log('cals changes found');
      changesFound = true;
      sort(calsDelta);
      delta.cals = calsDelta;
    }

    if (JSON.stringify(lastData.devicestatus) != JSON.stringify(data.devicestatus)) {
      console.log('devicestatus changes found');
      changesFound = true;
      delta.devicestatus = data.devicestatus;
    }

    if (JSON.stringify(lastData.profiles) != JSON.stringify(data.profiles)) {
      console.log('profile changes found');
      changesFound = true;
      delta.profiles = data.profiles;
    }

    if (changesFound) {
      console.log('changes found');
      return delta;
    }

    return data;

  };


  return data;

}

module.exports = init;