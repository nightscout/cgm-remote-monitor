'use strict';

var es = require('event-stream');
var find_options = require('./query');
var ObjectId = require('mongodb').ObjectId;
var moment = require('moment');
var runWithCallback = require('../storage/run-with-callback');

// REQ-SYNC-072: Pattern to match valid MongoDB ObjectId hex strings
var OBJECT_ID_HEX_RE = /^[0-9a-fA-F]{24}$/;

/**********\
 * Entries
 * Encapsulate persistent storage of sgv entries.
\**********/

function storage (env, ctx) {

  // TODO: Code is a little redundant.

  // query for entries from storage
  function list (opts, fn) {
    // these functions, find, sort, and limit, are used to
    // dynamically configure the request, based on the options we've
    // been given

    // determine sort options
    function sort () {
      return opts && opts.sort || { date: -1 };
    }

    // configure the limit portion of the current query
    function limit () {
      if (opts && opts.count) {
        return this.limit(parseInt(opts.count));
      }
      return this;
    }

    // handle all the results
    return runWithCallback(function () {
      return limit.call(api()
        .find(query_for(opts))
        .sort(sort())
      ).toArray();
    }, fn);
  }

  function remove (opts, fn) {
    return runWithCallback(async function () {
      var stat = await api().deleteMany(query_for(opts));
      ctx.bus.emit('data-update', {
        type: 'entries'
        , op: 'remove'
        , count: stat.deletedCount
        , changes: opts.find._id
      });

      //TODO: this is triggering a read from Mongo, we can do better
      ctx.bus.emit('data-received');
      return stat;
    }, fn);
  }

  // return writable stream to lint each sgv record passing through it
  // TODO: get rid of this? not doing anything now
  function map () {
    return es.map(function iter (item, next) {
      return next(null, item);
    });
  }

  // writable stream that persists all records
  // takes function to call when done
  function persist (fn) {
    // receives entire list at end of stream
    function done (err, result) {
      // report any errors
      if (err) { return fn(err, result); }
      // batch insert a list of records
      create(result, fn);
    }
    // lint and store the entire list
    return es.pipeline(map(), es.writeArray(done));
  }

  //TODO: implement
  //function update (fn) {
  //}
  //

  // store new documents using the storage mechanism
  function create (docs, fn) {
    // Handle empty array case - call callback immediately
    if (docs.length === 0) {
      return fn(null, docs);
    }

    // Prepare all documents and build bulk operations
    var bulkOps = docs.map(function(doc) {
      // REQ-SYNC-072: Normalize entry ID - extract UUID to identifier, handle _id
      normalizeEntryId(doc);
      
      // Normalize dates to be in UTC, store offset in utcOffset
      var _sysTime;

      if (doc.dateString) { _sysTime = moment.parseZone(doc.dateString); }
      if (!_sysTime && doc.date) { _sysTime = moment(doc.date); }
      if (!_sysTime) _sysTime = moment();

      doc.utcOffset = _sysTime.utcOffset();
      doc.sysTime = _sysTime.toISOString();
      if (doc.dateString) doc.dateString = doc.sysTime;

      // Build upsert query - prefer identifier, fall back to sysTime+type
      var query = upsertQueryFor(doc);

      return {
        updateOne: {
          filter: query,
          update: { $set: doc },
          upsert: true
        }
      };
    });

    return runWithCallback(async function () {
      var bulkResult;

      try {
        // Use bulkWrite for batch upsert
        bulkResult = await api().bulkWrite(bulkOps, { ordered: true });
      } catch (err) {
        console.error('Problem upserting entries batch', err);
        throw err;
      }

      // Assign _ids from upserted results
      if (bulkResult && bulkResult.upsertedIds) {
        Object.keys(bulkResult.upsertedIds).forEach(function(index) {
          docs[index]._id = bulkResult.upsertedIds[index];
        });
      }

      ctx.bus.emit('data-update', {
        type: 'entries'
        , op: 'update'
        , changes: ctx.ddata.processRawDataForRuntime(docs)
      });

      ctx.bus.emit('data-received');
      return docs;
    }, function (err, result) {
      if (err) {
        fn(err, docs);
        return;
      }
      fn(null, result);
    });
  }

  function getEntry (id, fn) {
    return runWithCallback(function () {
      return api().findOne({ "_id": new ObjectId(id) });
    }, fn);
  }

  function query_for (opts) {
    // Build queryOpts inside function to access env.uuidHandling
    var queryOpts = {
      walker: {
        date: parseInt
        , sgv: parseInt
        , filtered: parseInt
        , unfiltered: parseInt
        , rssi: parseInt
        , noise: parseInt
        , mbg: parseInt
      }
      , useEpoch: true
      , uuidHandling: env.uuidHandling
    };
    return find_options(opts, queryOpts);
  }

  // closure to represent the API
  function api () {
    // obtain handle usable for querying the collection associated
    // with these records
    return ctx.store.collection(env.entries_collection);
  }

  // Expose all the useful functions
  api.list = list;
  api.map = map;
  api.create = create;
  api.remove = remove;
  api.persist = persist;
  api.query_for = query_for;
  api.getEntry = getEntry;
  api.aggregate = require('./aggregate')({}, api);
  api.indexedFields = [
    'date'
    , 'type'
    , 'sgv'
    , 'mbg'
    , 'sysTime'
    , 'dateString'
    , 'identifier'  // REQ-SYNC-072: Client sync identity (Trio/Loop syncIdentifier)
    , { 'type': 1, 'date': -1, 'dateString': 1 }
    , { 'date': -1, 'identifier': -1, 'created_at': -1 }
 ];
 
  /**
   * Build upsert query for entry - GAP-SYNC-045 fix
   * 
   * For CGM entries, sysTime+type is ALWAYS the primary dedup key.
   * This ensures only one SGV reading per timestamp, regardless of source UUID.
   * 
   * The fix: strip non-ObjectId _id before $set to avoid "immutable field '_id'" error.
   * UUID is preserved in identifier field for reference.
   */
  function upsertQueryFor (doc) {
    // Always strip non-ObjectId _id to avoid "immutable field '_id'" error
    // The UUID has already been preserved in doc.identifier by normalizeEntryId()
    if (doc._id && typeof doc._id === 'string' && !OBJECT_ID_HEX_RE.test(doc._id)) {
      delete doc._id;
    }
    
    // Standard CGM dedup: sysTime + type (one reading per timestamp per type)
    if (doc.sysTime && doc.type) {
      return { sysTime: doc.sysTime, type: doc.type };
    }
    // Last resort
    return doc;
  }

  /**
   * Normalize entry ID - REQ-SYNC-072: Server-Controlled ID
   * 
   * Extracts client sync identity from _id if UUID:
   * - Trio: UUID in _id → moved to identifier
   * - Loop: syncIdentifier in _id → moved to identifier
   * 
   * Note: _id is stripped in upsertQueryFor to avoid MongoDB errors
   */
  function normalizeEntryId (doc) {
    // REQ-SYNC-072: Only handle UUID values in _id field
    // Scope: ONLY the _id field when value is a valid UUID
    if (typeof doc._id === 'string' && !OBJECT_ID_HEX_RE.test(doc._id)) {
      // Non-ObjectId string in _id (UUID format)
      // Only move to identifier when UUID_HANDLING is enabled
      if (env.uuidHandling && !doc.identifier) {
        doc.identifier = doc._id;
      }
      // Always delete invalid _id so server generates ObjectId
      delete doc._id;
    } else if (Object.prototype.hasOwnProperty.call(doc, '_id') && doc._id !== null && doc._id !== '') {
      // Convert valid ObjectId strings to ObjectId objects
      if (typeof doc._id === 'string' && OBJECT_ID_HEX_RE.test(doc._id)) {
        doc._id = new ObjectId(doc._id);
      }
    }
  }

  return api;
}

// expose module
storage.storage = storage;
module.exports = storage;
