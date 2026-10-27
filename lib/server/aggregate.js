var assertNoQueryJavascript = require('../storage/assert-no-query-javascript');
var runWithCallback = require('../storage/run-with-callback');
var reads = require('./storage-reads');

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

// `store`, when given, returns the module's storage interface (the handle its
// reads and writes go through, lib/server/storage-reads.js). The count then
// goes through the interface's count() in the API v1 dialect, and the number
// is shaped into the reply the $group below gives: [{_id: null, count: n}],
// and [] when nothing matches, since a $group over no documents emits no row.
// A constructor-supplied conf.pipeline has no interface form, so it, and a
// caller that passes no `store`, keep the driver pipeline; no module in this
// tree supplies either.
function create (conf, api, store) {

  var pipelineHook = conf && Array.isArray(conf.pipeline) && conf.pipeline.length > 0;
  var throughInterface = typeof store === 'function' && !pipelineHook;

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
    if (opts && opts.pipeline !== undefined) { return runWithCallback(refusePipeline, done); }

    // Everything that can refuse runs inside runWithCallback, so a refusal
    // reaches the caller through `done` exactly once instead of being thrown
    // synchronously out of the route handler.
    return runWithCallback(function () {
      // Build the filter with the collection's own `query_for`, so that
      // counting and listing can never disagree about the date field or the
      // value types.
      var query = api.query_for(opts);

      if (throughInterface) {
        var ast = reads.toFilter(query);
        return store().count(ast, { v1: true }).then(function shape (n) {
          return n > 0 ? [ { _id: null, count: n } ] : [ ];
        });
      }

      var pipeline = (conf.pipeline || [ ]);
      var groupBy = [ {$match: query } ].concat(pipeline).concat(template( ));
      // conf.pipeline is set by whoever constructs this module rather than by
      // a request, so this is a backstop rather than the guard. $match stages
      // are query context; every other stage is expression context, where
      // $function and $accumulator run JavaScript.
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
