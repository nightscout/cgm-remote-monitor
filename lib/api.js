function lastSgv (req, res) {
  var FORTY_MINUTES = 2400000;

  var cgmData = [ ];
  var last_sgv;
  function get_latest (err, collection) {
    var now = Date.now();
    var earliest_data = now - (FORTY_MINUTES*5);
    collection.find({ }).sort({"date": -1}).limit(1).toArray(function(err, results) {
        console.log('queried', new Date(earliest_data).toISOString( ),
                    new Date(now).toISOString( ), 'got raw results', results.length);
        results.forEach(function(element, index, array) {
            var last = cgmData[cgmData.length - 1];
            if (element) {
                console.log(element, index);
                last_sgv = element.sgv;
            }
        });
        
        res.setHeader('content-type', 'text/plain');
        res.write(last_sgv);
        res.end( );
        collection.db.close();
    });
  }
  req.with_collection(get_latest);
}

lastSgv.lastSgv = lastSgv;
module.exports = lastSgv;

