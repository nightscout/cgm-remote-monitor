var find_options = require('./query');
const assertNoQueryJavascript = require('../storage/assert-no-query-javascript');
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
    return runWithCallback(function () {
      var query = find_options(opts);

      var pipeline = (conf.pipeline || [ ]).concat(opts.pipeline || [ ]);
      var groupBy = [ {$match: query } ].concat(pipeline).concat(template( ));
      for (const stage of groupBy) {
        if (stage.$match) assertNoQueryJavascript(stage.$match);
        const expressions = Object.fromEntries(Object.entries(stage).filter(([key]) => key !== '$match'));
        assertNoQueryJavascript({$expr: expressions});
      }
      console.log('$match query', query);
      console.log('AGGREGATE', groupBy);
      return api().aggregate(groupBy).toArray();
    }, done);
  }

  return aggregate;

}

module.exports = create;
