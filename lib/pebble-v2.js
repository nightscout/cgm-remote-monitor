var DIRECTIONS = {
    NONE: 0,
    DoupleUp: 1,
    SingleUp: 2,
    FortyFiveUp: 3,
    Flat: 4,
    FortyFiveDown: 5,
    SingleDown: 6,
    DoubleDown: 7,
    'NOT COMPUTABLE': 8,
    'RATE OUT OF RANGE': 9
};
var FORTY_MINUTES = 2400000;

// Constructor
function Pebble(collection) {
    // always initialize all instance properties
    this.enteries = [];
    
    console.log(collection);
    
    this.enteries = this.getLatest(collection);
}
// class methods
Pebble.prototype.directionToTrend = function(direction) {
    var trend = 8;
    if (direction in DIRECTIONS) {
        trend = DIRECTIONS[direction];
    }
    return trend;
};

Pebble.prototype.getLatest = function(collection) {
    var cgmData = this.enteries;
    var result = "";
    
    var now = Date.now();
    var earliest_data = now - (FORTY_MINUTES*5);
    
    collection.find({ }).sort({"date": -1}).limit(10).toArray(function(results) {
        console.log('queried', new Date(earliest_data).toISOString( ),
        new Date(now).toISOString( ), 'got raw results', results.length);
        results.forEach(function(element, index, array) {
            var last = cgmData[cgmData.length - 1];
            if (element) {
                console.log(element, index);
                var obj = {};
                obj.sgv = element.sgv;
                obj.bgdelta = (last ? (last.sgv - element.sgv) : 0);
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
        collection.db.close();
    });
    
    return result;
};

// export the class
module.exports = Pebble;