const assertNoQueryJavascript = require('../storage/assert-no-query-javascript');
var runWithCallback = require('../storage/run-with-callback');

// BF-70. `opts` here is the caller's parsed query string -- count_records in
// lib/api/entries/index.js passes req.query straight through -- so
// `opts.pipeline` let a caller of GET /api/v1/count/:storage/where splice
// arbitrary AGGREGATION stages into the pipeline this module runs. That is a
// wider surface than the `find` filter by a long way: aggregation carries
// $lookup, which reads a collection the endpoint is not about.
//
// No caller in this tree supplies one. `conf.pipeline` is `{}` at all three
// construction sites (entries, treatments, devicestatus), `opts.pipeline` is
// documented nowhere, appears in no client in the operator census, and is
// named in neither swagger file. It is refused rather than dropped silently so
// that anyone who was relying on it is told, instead of quietly getting a
// different answer.
function refusePipeline ( ) {
  var error = new Error('The pipeline parameter is not supported by the Nightscout API v1. '
    + 'Use find[...] to filter the records a count is taken over.');
  error.name = 'MongoQueryValidationError';
  error.status = error.statusCode = 400;
  throw error;
}

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
      if (opts && opts.pipeline !== undefined) refusePipeline();
      var query = api.query_for(opts);

      var pipeline = (conf.pipeline || [ ]);
      var groupBy = [ {$match: query } ].concat(pipeline).concat(template( ));
      for (const stage of groupBy) {
        if (stage.$match) assertNoQueryJavascript(stage.$match);
        const expressions = Object.fromEntries(Object.entries(stage).filter(([key]) => key !== '$match'));
        assertNoQueryJavascript({$expr: expressions});
      }
      return api().aggregate(groupBy).toArray();
    }, done);
  }

  return aggregate;

}

module.exports = create;
