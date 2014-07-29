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
  function get_latest (err, collection) {
    var now = Date.now();
    var earliest_data = now - (FORTY_MINUTES*5);
    collection.find({ }).sort({"date": -1}).limit(10).toArray(function(err, results) {
        console.log('queried', new Date(earliest_data).toISOString( ),
                    new Date(now).toISOString( ), 'got raw results', results.length);
        results.forEach(function(element, index, array) {
            var next = null;
            if (index + 1 < results.length) {
              next = results[index + 1];
            }
            if (element) {
                var obj = {};
                obj.sgv = element.sgv;
                obj.bgdelta = (next ? (element.sgv - next.sgv ) : 0);
                if ('direction' in element) {
                  obj.trend = directionToTrend(element.direction);
                  obj.direction = element.direction;
                }
                // obj.y = element.sgv;
                // obj.x = element.date;
                obj.datetime = element.date;
                // obj.date = element.date.toString( );
                cgmData.push(obj);
            }
        });
        // cgmData.reverse( );
        var result = { status: [ {now:now}], bgs: cgmData.slice(0, 6) };
        console.log('RESULT', result);
        res.setHeader('content-type', 'application/json');
        res.write(JSON.stringify(result));
        res.end( );
        collection.db.close();
    });
  }
  req.with_collection(get_latest);
}

pebble.pebble = pebble;
module.exports = pebble;

