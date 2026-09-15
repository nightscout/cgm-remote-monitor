var runWithCallback = require('../storage/run-with-callback');

function create (conf, api) {

  var template = function ( ) {
    return [
        {
          $group: {
            _id: null
          , count: { $sum: 1 }
          }
        }
      ];
  };

  // var collection = api( );
  function aggregate (opts, done) {
    // Build the filter with the collection's own `query_for`, so that counting
    // and listing can never disagree about the date field or the value types.
    var query = api.query_for(opts);

    var pipeline = (conf.pipeline || [ ]).concat(opts.pipeline || [ ]);
    var groupBy = [ {$match: query } ].concat(pipeline).concat(template( ));
    return runWithCallback(function () {
      return api().aggregate(groupBy).toArray();
    }, done);
  }

  return aggregate;

}

module.exports = create;
