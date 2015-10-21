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
  var FORTY_MINUTES = 2400000;
  var cgmData = [ ];
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
    results.forEach(function(element, index, array) {
        var next = null;
        if (index + 1 < results.length) {
          next = results[index + 1];
        }
        if (element) {
            var obj = {};
            if (!element.sgv) return;
            obj.sgv = scaleBg(element.sgv).toString( );
            obj.bgdelta = (next ? (scaleBg(element.sgv) - scaleBg(next.sgv) ) : 0);
            if (useMetricBg) {
                obj.bgdelta = obj.bgdelta.toFixed(1);
            }
            if ('direction' in element) {
              obj.trend = directionToTrend(element.direction);
              obj.direction = element.direction;
            }
            // obj.y = element.sgv;
            // obj.x = element.date;
            obj.datetime = element.date;
            obj.battery = uploaderBattery ? "" + uploaderBattery : undefined;
            obj.iob = iobTotal(treatmentResults.slice(0, 20), now);
            // obj.date = element.date.toString( );
            cgmData.push(obj);
        }
    });
    var result = { status: [ {now:now}], bgs: cgmData.slice(0, 1) };
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

      var earliest_data = Date.now() - (5 * 3600000);
      var tq = { find: {"created_at": {"$gte": new Date(earliest_data).toISOString()}} };
      req.treatments.list(tq, function (err, trs) {
        treatmentResults = trs;
        req.entries.list({count: 2, find: { "sgv": { $exists: true }}}, get_latest);
      });
  });
}

function configure (entries, treatments, devicestatus) {
  function middle (req, res, next) {
    req.entries = entries;
    req.treatments = treatments;
    req.devicestatus = devicestatus;
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
