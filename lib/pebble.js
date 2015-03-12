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

function directionToTrend (direction) {
  var trend = 8;
  if (direction in DIRECTIONS) {
    trend = DIRECTIONS[direction];
  }
  return trend;
}

function pebble (req, res) {
  var ONE_DAY = 24 * 60 * 60 * 1000;
  var useMetricBg = (req.query.units === "mmol");
  var uploaderBattery;
  var treatmentResults;
  var profileResult;

  function scaleBg(bg) {
      if (useMetricBg) {
          return (Math.round((bg / 18) * 10) / 10).toFixed(1);
      } else
          return bg;
  }

  function get_latest (err, results) {
    var now = Date.now();
    var sgvData = [ ];
    var calData = [ ];

    results.forEach(function(element, index, array) {
        if (element) {
            var obj = {};
            if (element.sgv) {
                var next = null;
                var sgvs = results.filter(function(d) {
                    return !!d.sgv;
                });
                if (index + 1 < sgvs.length) {
                    next = sgvs[index + 1];
                }
                obj.sgv = scaleBg(element.sgv).toString();
                obj.bgdelta = (next ? (scaleBg(element.sgv) - scaleBg(next.sgv) ) : 0);
                if (useMetricBg) {
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
                    obj.rssi = element.rssi;
                }
                // obj.date = element.date.toString( );
                sgvData.push(obj);
            } else if (req.rawbg && element.type == 'cal') {
                calData.push(element);
            }
        }
    });

    var count = parseInt(req.query.count) || 1;

    var bgs = sgvData.slice(0, count);
    //for compatibility we're keeping battery and iob here, but they would be better somewhere else
    bgs[0].battery = uploaderBattery ? "" + uploaderBattery : undefined;
    if (req.iob) {
        bgs[0].iob = iob.calcTotal(treatmentResults.slice(0, 20), profileResult, new Date(now)).display;
    }

    var result = { status: [ {now:now}], bgs: bgs, cals: calData.slice(0, count) };
    res.setHeader('content-type', 'application/json');
    res.write(JSON.stringify(result));
    res.end( );
    // collection.db.close();
  }
  req.devicestatus.last(function(err, value) {
      if (!err && value) {
        uploaderBattery = value.uploaderBattery;
      } else {
        console.error("req.devicestatus.tail", err);
      }

      var earliest_data = Date.now() - ONE_DAY;
      loadTreatments(req, earliest_data, function (err, trs) {
        treatmentResults = trs;
          loadProfile(req, function (err, profileResults) {
            profileResults.forEach(function(profile) {
              if (profile) {
                if (profile.dia) {
                  profileResult = profile;
                }
              }
            });
            var q = { find: {"date": {"$gte": earliest_data}} };
            req.entries.list(q, get_latest);
          });
      });
  });
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
    next( );
  }
  return [middle, pebble];
}

configure.pebble = pebble;
module.exports = configure;
