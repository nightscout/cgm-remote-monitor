

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
  }
  // var collection = api( );
  function aggregate (opts, done) {
    var query = api.query_for(opts);

    var pipeline = (conf.pipeline || [ ]).concat(opts.pipeline || [ ]);
    var groupBy = [ {$match: query } ].concat(pipeline).concat(template( ));
    console.log("AGGREGATE", groupBy);
    api( ).aggregate(groupBy, done);
  }

  return aggregate;

}

module.exports = create;

