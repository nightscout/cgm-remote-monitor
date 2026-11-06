var runWithCallback = require('../storage/run-with-callback');
var reads = require('./storage-reads');

// BF-70. `opts` here is the caller's parsed query string -- count_records in
// lib/api/entries/index.js passes req.query straight through -- so
// `opts.pipeline` let a caller of GET /api/v1/count/:storage/where splice
// arbitrary AGGREGATION stages into the pipeline this module runs. That is a
// wider surface than the `find` filter by a long way: aggregation carries
// $lookup, which reads a collection the endpoint is not about.
//
// `opts.pipeline` is documented nowhere, appears in no client in the operator
// census, and is named in neither swagger file. It is refused rather than
// dropped silently so that anyone who was relying on it is told, instead of
// quietly getting a different answer.
function refusePipeline ( ) {
  var error = new Error('The pipeline parameter is not supported by the Nightscout API v1. '
    + 'Use find[...] to filter the records a count is taken over.');
  error.name = 'MongoQueryValidationError';
  error.status = error.statusCode = 400;
  throw error;
}

// `store` returns the module's storage interface (the handle its reads and
// writes go through, lib/server/storage-reads.js). The count goes through the
// interface's count() in the API v1 dialect, and the number is shaped into the
// reply the driver's $group gave: [{_id: null, count: n}], and [] when nothing
// matches, since a $group over no documents emits no row. There is no other
// path: a module without an interface cannot count.
function create (api, store) {

  if (typeof store !== 'function') {
    throw new TypeError('lib/server/aggregate.js counts through a storage interface; pass the module\'s store()');
  }

  function aggregate (opts, done) {
    if (opts && opts.pipeline !== undefined) { return runWithCallback(refusePipeline, done); }

    // Everything that can refuse runs inside runWithCallback, so a refusal
    // reaches the caller through `done` exactly once instead of being thrown
    // synchronously out of the route handler.
    return runWithCallback(function () {
      // Build the filter with the collection's own `query_for`, so that
      // counting and listing can never disagree about the date field or the
      // value types.
      var ast = reads.toFilter(api.query_for(opts));
      return store().count(ast, { v1: true }).then(function shape (n) {
        return n > 0 ? [ { _id: null, count: n } ] : [ ];
      });
    }, done);
  }

  return aggregate;

}

module.exports = create;
