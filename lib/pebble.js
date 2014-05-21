
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
            var last = cgmData[cgmData.length - 1];
            if (element) {
                console.log(element, index);
                var obj = {};
                obj.sgv = element.sgv;
                obj.bgdelta = (last ? (last.sgv - element.sgv) : 0);
                obj.trend = 0;
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

