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

      req.entries.list({count: 2, find: { "sgv": { $exists: true }}}, get_latest);
  });
}
function configure (entries, devicestatus) {
  function middle (req, res, next) {
    req.entries = entries;
    req.devicestatus = devicestatus;
    next( );
  }
  return [middle, pebble];
}

configure.pebble = pebble;
module.exports = configure;
