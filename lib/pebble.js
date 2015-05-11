'use strict';

var DIRECTIONS = {
  NONE: 0
, DoubleUp: 1
, SingleUp: 2
, FortyFiveUp: 3
, Flat: 4
, FortyFiveDown: 5
, SingleDown: 6
, DoubleDown: 7
, 'NOT COMPUTABLE': 8
, 'RATE OUT OF RANGE': 9
};

var iob = require("./iob")();
var async = require('async');
var units = require('./units')();

function directionToTrend (direction) {
  var trend = 8;
  if (direction in DIRECTIONS) {
    trend = DIRECTIONS[direction];
  }
  return trend;
}

function pebble (req, res) {
  var ONE_DAY = 24 * 60 * 60 * 1000
      , uploaderBattery
      , treatmentResults
      , profileResult
      , sgvData = [ ]
      , calData = [ ];

  function scaleBg(bg) {
      if (req.mmol) {
          return units.mgdlToMMOL(bg);
      } else {
          return bg;
      }
  }

  function sendData () {
    var now = Date.now();

    //for compatibility we're keeping battery and iob here, but they would be better somewhere else
    if (sgvData.length > 0) {
        sgvData[0].battery = uploaderBattery ? "" + uploaderBattery : undefined;
        if (req.iob) {
            sgvData[0].iob = iob.calcTotal(treatmentResults.slice(0, 20), profileResult, new Date(now)).display;
        }
    }

    var result = { status: [ {now: now} ], bgs: sgvData.slice(0, req.count), cals: calData };
    res.setHeader('content-type', 'application/json');
    res.write(JSON.stringify(result));
    res.end( );
  }

    var earliest_data = Date.now() - ONE_DAY;

    async.parallel({
        devicestatus: function (callback) {
            req.devicestatus.last(function (err, value) {
                if (!err && value) {
                    uploaderBattery = value.uploaderBattery;
                } else {
                    console.error("req.devicestatus.tail", err);
                }
                callback();
            });
        }
        , treatments: function(callback) {
            loadTreatments(req, earliest_data, function (err, trs) {
                treatmentResults = trs;
                callback();
            });
        }
        , profile: function(callback) {
            loadProfile(req, function (err, profileResults) {
                if (!err && profileResults) {
                  profileResults.forEach(function (profile) {
                      if (profile) {
                          if (profile.dia) {
                              profileResult = profile;
                          }
                      }
                  });
                } else {
                  console.error("pebble profile error", arguments);
                }
                callback();
            });
        }
        , cal: function(callback) {
            if (req.rawbg) {
                var cq = { count: req.count, find: {type: 'cal'} };
                req.entries.list(cq, function (err, results) {
                  if (!err && results) {
                    results.forEach(function (element) {
                        if (element) {
                          calData.push({
                              slope: Math.round(element.slope)
                              , intercept: Math.round(element.intercept)
                              , scale: Math.round(element.scale)
                          });
                        }
                    });
                  } else {
                    console.error("pebble cal error", arguments);
                  }
                  callback();
                });
            } else {
                callback();
            }
        }
        , entries: function(callback) {
            var q = { count: req.count + 1, find: { "sgv": { $exists: true }} };

            req.entries.list(q, function(err, results) {
              if (!err && results) {
                results.forEach(function(element, index) {
                    if (element) {
                        var obj = {};
                        var next = null;
                        var sgvs = results.filter(function(d) {
                            return !!d.sgv;
                        });
                        if (index + 1 < sgvs.length) {
                            next = sgvs[index + 1];
                        }
                        obj.sgv = scaleBg(element.sgv).toString();
                        obj.bgdelta = (next ? (scaleBg(element.sgv) - scaleBg(next.sgv) ) : 0);
                        if (req.mmol) {
                            obj.bgdelta = obj.bgdelta.toFixed(1);
                        }
                        if ('direction' in element) {
                            obj.trend = directionToTrend(element.direction);
                            obj.direction = element.direction;
                        }
                        obj.datetime = element.date;
                        if (req.rawbg) {
                            obj.filtered = element.filtered;
                            obj.unfiltered = element.unfiltered;
                            obj.noise = element.noise;
                        }
                        sgvData.push(obj);
                    }
                });
              } else {
                console.error("pebble entries error", arguments);
              }
                callback();
            });
        }
    }, sendData);

}

function loadTreatments(req, earliest_data, fn) {
  if (req.iob) {
    var q = { find: {"created_at": {"$gte": new Date(earliest_data).toISOString()}} };
    req.treatments.list(q, fn);
  } else {
    fn(null, []);
  }
}

function loadProfile(req, fn) {
  if (req.iob) {
    req.profile.list(fn);
  } else {
    fn(null, []);
  }
}

function configure (entries, treatments, profile, devicestatus, env) {
  function middle (req, res, next) {
    req.entries = entries;
    req.treatments = treatments;
    req.profile = profile;
    req.devicestatus = devicestatus;
    req.rawbg = env.enable && env.enable.indexOf('rawbg') > -1;
    req.iob = env.enable && env.enable.indexOf('iob') > -1;
    req.mmol = (req.query.units || env.DISPLAY_UNITS) === 'mmol';
    req.count = parseInt(req.query.count) || 1;

    next( );
  }
  return [middle, pebble];
}

configure.pebble = pebble;
module.exports = configure;
