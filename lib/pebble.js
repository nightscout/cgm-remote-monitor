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

function directionToTrend (direction) {
  var trend = 8;
  if (direction in DIRECTIONS) {
    trend = DIRECTIONS[direction];
  }
  return trend;
}

function pebble (req, res) {
  var ONE_DAY = 24 * 60 * 60 * 1000;
  var uploaderBattery;
  var treatmentResults;

  function requestMetric() {
      var units = req.query.units;
      if (units == "mmol") {
        return true;
      }
      return false;
  }
  var useMetricBg = requestMetric();

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
    //for compatibility we're keeping battery here, but it would be better somewhere else
    bgs[0].battery = uploaderBattery ? "" + uploaderBattery : undefined;
    bgs[0].iob = iobTotal(treatmentResults.slice(0, 20), now);

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
      var q = { find: {"date": {"$gte": earliest_data}} };
      var tq = { find: {"created_at": {"$gte": new Date(earliest_data).toISOString()}} };
      req.treatments.list(tq, function (err, trs) {
        treatmentResults = trs;
        req.entries.list(q, get_latest);
      });
  });
}

function configure (entries, treatments, devicestatus, env) {
  function middle (req, res, next) {
    req.entries = entries;
    req.treatments = treatments;
    req.devicestatus = devicestatus;
    req.rawbg = true;
    next( );
  }
  return [middle, pebble];
}

function iobTotal(treatments, time) {
  var iob= 0;
  if (!treatments) return {};
  if (typeof time === 'undefined') {
    time = new Date();
  }

  treatments.forEach(function(treatment) {
    if(new Date(treatment.created_at).getTime() < time) {
      iob += iobCalc(treatment, time);
    }
  });
  return iob.toFixed(2);
}

function iobCalc(treatment, time) {

  //TODO: hard coded for 3hr insulin action
  var peak=75;

  if (treatment.insulin) {
    var bolusTime = new Date(treatment.created_at);
    var minAgo = (time-bolusTime) / 1000 / 60;

    var iobContrib = 0;
    if (minAgo < peak) {
      var x = minAgo/5+1;
      iobContrib = treatment.insulin * (1-0.001852*x*x+0.001852*x);
    } else if (minAgo < 180) {
      var x = (minAgo-75)/5;
      iobContrib = treatment.insulin * (0.001323*x*x - .054233*x + .55556);
    }

    return iobContrib;
  }
  else {
    return 0;
  }
}

configure.pebble = pebble;
module.exports = configure;
