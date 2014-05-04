
function pebble (req, res) {
  var now = Date.now();
  var FORTY_MINUTES = 2400000;

  cgmData = [];
  var earliest_data = now - FORTY_MINUTES;
  function get_latest (err, collection) {
    collection.find({"date": {"$gte": earliest_data}}).toArray(function(err, results) {
        results.forEach(function(element, index, array) {
            var last = cgmData[cgmData.length];
            if (element) {
                console.log(element, index);
                var obj = {};
                obj.sgv = element.sgv;
                obj.bgdelta = last ? (last.sgv - element.sgv) : false;
                obj.trend = '';
                obj.y = element.sgv;
                obj.x = element.date;
                obj.datetime = element.date;
                cgmData.push(obj);
            }
        });
        cgmData.reverse( );
        var result = { status: [ {now:now}], bgs: cgmData };
        res.write(JSON.stringify(result));
        res.end( );
        console.log(collection, collection);
        // collection.db.close();
    });
  }
  req.with_collection(get_latest);
}

pebble.pebble = pebble;
module.exports = pebble;

