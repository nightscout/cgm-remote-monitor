'use strict';

var moment = require('moment');
var find_options = require('./query');

/**
 * Truncate OpenAPS prediction arrays to a bounded length.
 *
 * This helper limits the size of `openaps.suggested.predBGs` and
 * `openaps.enacted.predBGs` arrays to avoid unbounded growth of
 * `devicestatus` documents, which helps keep MongoDB documents
 * under the 16 MB size limit.
 *
 * The function only operates on the following prediction series,
 * when present:
 *   - `IOB` (insulin-on-board-based predictions)
 *   - `COB` (carbs-on-board-based predictions)
 *   - `UAM` (unannounced-meal-based predictions)
 *   - `ZT`  (zero-temp-based predictions)
 *
 * The `maxSize` argument defines the maximum number of prediction
 * points retained per series. When not explicitly configured by
 * `env.predictionsMaxSize`, this is typically set to 288, which
 * corresponds to 24 hours of 5-minute prediction intervals
 * (24 * 60 / 5) and provides a practical upper bound to keep
 * documents reasonably small for MongoDB storage.
 *
 * If `maxSize` is falsy or not a positive number, the input
 * object is returned unmodified.
 *
 * @param {Object} obj - The devicestatus-like object potentially containing
 *   `openaps.suggested.predBGs` and/or `openaps.enacted.predBGs`.
 * @param {number} maxSize - Maximum allowed length for each prediction array
 *   (commonly 288 by default).
 * @returns {Object} The same object reference, possibly with truncated
 *   prediction arrays.
 */
function truncatePredictions (obj, maxSize) {
  if (!maxSize || maxSize <= 0) return obj;

  var predictionTypes = ['IOB', 'COB', 'UAM', 'ZT'];

  if (obj && obj.openaps && obj.openaps.suggested && obj.openaps.suggested.predBGs) {
    var suggestedPredBGs = obj.openaps.suggested.predBGs;
    predictionTypes.forEach(function(type) {
      if (Array.isArray(suggestedPredBGs[type]) && suggestedPredBGs[type].length > maxSize) {
        suggestedPredBGs[type] = suggestedPredBGs[type].slice(0, maxSize);
      }
    });
  }

  if (obj && obj.openaps && obj.openaps.enacted && obj.openaps.enacted.predBGs) {
    var enactedPredBGs = obj.openaps.enacted.predBGs;
    predictionTypes.forEach(function(type) {
      if (Array.isArray(enactedPredBGs[type]) && enactedPredBGs[type].length > maxSize) {
        enactedPredBGs[type] = enactedPredBGs[type].slice(0, maxSize);
      }
    });
  }

  return obj;
}

function storage (env, ctx) {

  var collection = env.devicestatus_collection;
  var predictionsMaxSize = env.predictionsMaxSize || null;

  function create (statuses, fn) {

    if (!Array.isArray(statuses)) { statuses = [statuses]; }

    if (statuses.length === 0) {
      return fn(null, []);
    }

    // Prepare all documents before insert
    statuses.forEach(function(obj) {
      var d = moment(obj.created_at).isValid() ? moment.parseZone(obj.created_at) : moment();
      obj.created_at = d.toISOString();
      obj.utcOffset = d.utcOffset();
      truncatePredictions(obj, predictionsMaxSize);
    });

    // Use insertMany for batch insert
    api().insertMany(statuses, { ordered: true }, function(err, insertResult) {
      if (err) {
        console.log('Error inserting device status objects', err.message);
        fn(err.message || err, null);
        return;
      }

      // Assign _ids from insertMany result
      if (insertResult && insertResult.insertedIds) {
        Object.keys(insertResult.insertedIds).forEach(function(index) {
          statuses[index]._id = insertResult.insertedIds[index];
        });
      }

      // Emit data-update for all inserted documents
      ctx.bus.emit('data-update', {
        type: 'devicestatus'
        , op: 'update'
        , changes: ctx.ddata.processRawDataForRuntime(statuses)
      });

      ctx.bus.emit('data-received');
      fn(null, statuses);
    });
  }

  function last (fn) {
    return list({ count: 1 }, function(err, entries) {
      if (entries && entries.length > 0) {
        fn(err, entries[0]);
      } else {
        fn(err, null);
      }
    });
  }

  function query_for (opts) {
    return find_options(opts, storage.queryOpts);
  }

  function list (opts, fn) {
    // these functions, find, sort, and limit, are used to
    // dynamically configure the request, based on the options we've
    // been given

    // determine sort options
    function sort () {
      return opts && opts.sort || { created_at: -1 };
    }

    // configure the limit portion of the current query
    function limit () {
      if (opts && opts.count) {
        return this.limit(parseInt(opts.count));
      }
      return this;
    }

    // handle all the results
    function toArray (err, entries) {
      fn(err, entries);
    }

    // now just stitch them all together
    limit.call(api()
      .find(query_for(opts))
      .sort(sort())
    ).toArray(toArray);
  }

  function remove (opts, fn) {

    function removed (err, stat) {

      ctx.bus.emit('data-update', {
        type: 'devicestatus'
        , op: 'remove'
        , count: stat.deletedCount
        , changes: opts.find._id
      });

      fn(err, stat);
    }

    return api().deleteMany(
      query_for(opts), removed);
  }

  function api () {
    return ctx.store.collection(collection);
  }

  api.list = list;
  api.create = create;
  api.query_for = query_for;
  api.last = last;
  api.remove = remove;
  api.aggregate = require('./aggregate')({}, api);
  api.indexedFields = [
    'created_at'



  
    , 'NSCLIENT_ID'
  ];
  return api;
}

storage.queryOpts = {
  dateField: 'created_at'
};

module.exports = storage;
