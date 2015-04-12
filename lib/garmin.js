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

function garmin (req, res) {
  var ONE_DAY = 24 * 60 * 60 * 1000;
  var uploaderBattery;

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
                obj.sgv = scaleBg(element.sgv);
                obj.bgdelta = (next ? (scaleBg(element.sgv) - scaleBg(next.sgv) ) : 0);
		obj.timedelta = Number((Date.now( ) - element.date)/60000.0).toFixed( 0 );
                if (useMetricBg) {
                    obj.bgdelta = obj.bgdelta.toFixed(1);
                }
                if ('direction' in element) {
                    obj.trend = directionToTrend(element.direction);
                }
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

    var result = bgs[0];
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
      req.entries.list(q, get_latest);
  });
}
function configure (entries, devicestatus, env) {
  function middle (req, res, next) {
    req.entries = entries;
    req.devicestatus = devicestatus;
    req.rawbg = env.enable && env.enable.indexOf('rawbg') > -1;
    next( );
  }
  return [middle, garmin];
}

configure.garmin = garmin;
module.exports = configure;
