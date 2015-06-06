'use strict';

var async = require('async');

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
    , TWO_DAYS = 172800000
    ;

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
            results.forEach(function (element) {
              if (element) {
                if (element.mbg) {
                  data.mbgs.push({
                    y: element.mbg, x: element.date, d: element.dateString, device: element.device
                  });
                } else if (element.sgv) {
                  data.sgvs.push({
                    y: element.sgv, x: element.date, d: element.dateString, device: element.device, direction: directionToChar(element.direction), filtered: element.filtered, unfiltered: element.unfiltered, noise: element.noise, rssi: element.rssi
                  });
                }
              }
            });
          }

          //FIXME: sort in mongo
          sort(data.mbgs);
          sort(data.sgvs);
          callback();
        })
      }, cal: function (callback) {
        //FIXME: date $gte?????
        var cq = { count: 1, find: {"type": "cal"} };
        ctx.entries.list(cq, function (err, results) {
          if (!err && results) {
            results.forEach(function (element) {
              if (element) {
                data.cals.push({
                  x: element.date, d: element.dateString, scale: element.scale, intercept: element.intercept, slope: element.slope
                });
              }
            });
          }
          callback();
        });
      }, treatments: function (callback) {
        var tq = { find: {"created_at": {"$gte": new Date(treatment_earliest_data).toISOString()}} };
        ctx.treatments.list(tq, function (err, results) {
          if (!err && results) {
            data.treatments = results.map(function (treatment) {
              var timestamp = new Date(treatment.timestamp || treatment.created_at);
              treatment.x = timestamp.getTime();
              return treatment;
            });

            //FIXME: sort in mongo
            data.treatments.sort(function(a, b) {
              return a.x - b.x;
            });
          }
          callback();
        });
      }, profile: function (callback) {
        ctx.profile.list(function (err, results) {
          if (!err && results) {
            // There should be only one document in the profile collection with a DIA.  If there are multiple, use the last one.
            results.forEach(function (element, index, array) {
              if (element) {
                if (element.dia) {
                  data.profiles[0] = element;
                }
              }
            });
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

  return data;

}

module.exports = init;