'use strict';

const writeStep = require('../storage/write-step');
const writeIntent = require('../storage/write-intent');

const READ_OPTIONS = require('../storage/mongo-read-options');

var moment = require('moment');
var find_options = require('./query');
var runWithCallback = require('../storage/run-with-callback');
var purifyForStorage = require('./storage-purifier');
var reads = require('./storage-reads');
var idForms = require('./object-id-forms');
var softDeleted = require('./soft-deleted');

function truncatePredictions (obj, maxSize) {
  if (!maxSize || maxSize <= 0) return obj;
  
  if (obj && obj.openaps && obj.openaps.suggested && obj.openaps.suggested.predBGs) {
    var predBGs = obj.openaps.suggested.predBGs;
    var predictionTypes = ['IOB', 'COB', 'UAM', 'ZT'];
    
    predictionTypes.forEach(function(type) {
      if (Array.isArray(predBGs[type]) && predBGs[type].length > maxSize) {
        predBGs[type] = predBGs[type].slice(0, maxSize);
      }
    });
  }
  
  if (obj && obj.openaps && obj.openaps.enacted && obj.openaps.enacted.predBGs) {
    var enactedPredBGs = obj.openaps.enacted.predBGs;
    predictionTypes = ['IOB', 'COB', 'UAM', 'ZT'];
    
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

  // Writes go through the write step (lib/storage/write-intent.js), which
  // holds the rules this module applied itself: the identifier rule (a status
  // whose identifier is stored is merged into it and answered with the stored
  // _id; ID-Q2, ID-FIRST-MATCH slice 4), the `_id` rule (a 24-hex
  // _id is stored as its ObjectId; one already stored, in either form, is
  // answered with it and not written), server dates and the unordered
  // insert. created_at, the predictions cap and every bus emission stay here.
  function step ( ) {
    return writeIntent.forCollectionResolved(store, 'devicestatus', 'v1/internal', { env: env });
  }

  function create (statuses, fn) {

    if (!Array.isArray(statuses)) { statuses = [statuses]; }

    if (statuses.length === 0) {
      if (typeof fn === 'function') return fn(null, []);
      return Promise.resolve([]);
    }

    try {
      purifyForStorage(ctx, statuses);
    } catch (err) {
      if (typeof fn === 'function') return fn(err, []);
      return Promise.reject(err);
    }

    // Prepare all documents before insert
    statuses.forEach(function(obj) {
      var d = moment(obj.created_at).isValid() ? moment.parseZone(obj.created_at) : moment();
      obj.created_at = d.toISOString();
      obj.utcOffset = d.utcOffset();
      truncatePredictions(obj, predictionsMaxSize);
    });

    return runWithCallback(async function () {
      var result;
      try {
        result = await step().write({ op: 'create', docs: statuses });
      } catch (err) {
        if (err instanceof writeIntent.WriteRuleError) {
          console.log('Error reading device status ids', err.cause.message);
          throw err.cause.message || err.cause;
        }
        console.log('Error inserting device status objects', err.message);
        throw err.message || err;
      }

      // What was written: the statuses inserted, then those a re-send by
      // identifier merged into (ID-Q2), as they are now stored.
      var written = result.inserted.concat(result.merged || []);
      if (written.length === 0) {
        return statuses;
      }

      // Emit data-update for all inserted and merged documents
      ctx.bus.emit('data-update', {
        type: 'devicestatus'
        , op: 'update'
        , changes: ctx.ddata.processRawDataForRuntime(written)
      });

      ctx.bus.emit('data-received');
      return statuses;
    }, fn);
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

  // Reads leave out deleted records (isValid: false; see soft-deleted).
  function query_for (opts) {
    return softDeleted.visible(stored_query_for(opts), opts);
  }

  // Every stored record the query names, deleted or not: what DELETE removes.
  function stored_query_for (opts) {
    var asked = opts && opts.find && opts.find._id;
    // find[_id]=<hex> (also used by DELETE /devicestatus/:id) comes back as
    // an ObjectId; also match a record stored with the same id as a string.
    return idForms.matchEitherForm(find_options(opts, storage.queryOpts), asked);
  }

  function list (opts, fn) {
    // these functions, find, sort, and limit, are used to
    // dynamically configure the request, based on the options we've
    // been given

    // determine sort options
    function sort () {
      return opts && opts.sort || { created_at: -1 };
    }

    // Through the storage interface; count, sort and read options as before
    // (lib/server/storage-reads.js).
    return runWithCallback(function () {
      return reads.list(store(), query_for(opts)
        , { sort: sort(), count: opts && opts.count, readOptions: READ_OPTIONS });
    }, fn);
  }

  function remove (opts, fn) {
    // The id as asked: query_for rewrites opts.find._id into a filter.
    var asked = opts && opts.find ? opts.find._id : undefined;

    return runWithCallback(async function () {
      var written = await step().write({ op: 'delete', target: { filter: stored_query_for(opts) } });
      var stat = written.adapter;
      console.log('removed', null, stat);
      ctx.bus.emit('data-update', {
        type: 'devicestatus'
        , op: 'remove'
        , count: stat.deletedCount
        , changes: idForms.namedCacheRemoval(written.removed, asked, stat.deletedCount)
      });

      // Reload now, as entries and treatments removes do: the remove may
      // have emptied the devicestatus cache, which otherwise stays empty
      // until the next heartbeat.
      ctx.bus.emit('data-received');
      return stat;
    }, fn);
  }

  // Reads and writes go through the storage interface, labelled 'v1/internal'
  // (lib/server/storage-reads.js; writes through lib/storage/write-intent.js).
  function store () {
    return reads.collection(ctx, env, collection, 'devicestatus');
  }

  // The handle tests seed through; lib/server/aggregate.js counts through store().
  function api () {
    return writeStep.collection(ctx.store.collection(collection), {name: 'devicestatus',
      source: 'v1/internal', bus: ctx.bus});
  }

  api.list = list;
  api.create = create;
  api.query_for = query_for;
  api.last = last;
  api.remove = remove;
  api.aggregate = require('./aggregate')(api, store);
  api.indexedFields = [
    'created_at'



  
    , 'NSCLIENT_ID'
    , { 'created_at': -1, 'identifier': -1, 'date': -1 }
  ];
  return api;
}

storage.queryOpts = {
  collection: 'devicestatus'
  , dateField: 'created_at'
};

module.exports = storage;
