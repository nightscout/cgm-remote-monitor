var find_options = require('./query');

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
    var query = find_options(opts);

    var pipeline = (conf.pipeline || [ ]).concat(opts.pipeline || [ ]);
    var groupBy = [ {$match: query } ].concat(pipeline).concat(template( ));
    console.log('$match query', query);
    console.log('AGGREGATE', groupBy);
    api( ).aggregate(groupBy, done);
  }

  return aggregate;

}

module.exports = create;

