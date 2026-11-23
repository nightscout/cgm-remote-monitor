'use strict';

var es = require('event-stream');
var find_options = require('./query');
var ObjectId = require('mongodb').ObjectId;
var moment = require('moment');
var runWithCallback = require('../storage/run-with-callback');
var purifyForStorage = require('./storage-purifier');
var countParam = require('./count');
var srvDates = require('./srv-dates');
var softDeleted = require('./soft-deleted');

// REQ-SYNC-072: the 24-hex _id rule lives in object-id-forms.
var idForms = require('./object-id-forms');

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
      return countParam.applyCount(this, opts);
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
    // The id as asked: query_for rewrites opts.find._id into a filter.
    var asked = opts && opts.find ? opts.find._id : undefined;
    return runWithCallback(async function () {
      var stat = await api().deleteMany(stored_query_for(opts));
      ctx.bus.emit('data-update', {
        type: 'entries'
        , op: 'remove'
        , count: stat.deletedCount
        , changes: idForms.cacheRemoval(asked, stat.deletedCount)
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
      if (typeof fn === 'function') return fn(null, docs);
      return Promise.resolve(docs);
    }

    try {
      purifyForStorage(ctx, docs);
      docs.forEach(function (doc) {
        if (Object.prototype.hasOwnProperty.call(doc, 'type')
          && doc.type !== null && typeof doc.type !== 'string') {
          throw new TypeError('Entry type must be a string');
        }
      });
    } catch (err) {
      if (typeof fn === 'function') return fn(err, docs);
      return Promise.reject(err);
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

      // An _id is set only when the upsert inserts. When it matches a stored
      // entry (same sysTime and type), that entry keeps its own _id, as it
      // does for a POST without _id; writing the sent _id into the update
      // would make MongoDB refuse it whenever the stored _id differs, for
      // example an entry stored with the string form by 15.0.6 or earlier.
      // srvModified on every write, srvCreated only when the upsert inserts
      // (API v3 history reads them; see srv-dates).
      srvDates.stampModified(doc);
      var update = { $set: doc };
      if (Object.prototype.hasOwnProperty.call(doc, '_id')) {
        var fields = Object.assign({}, doc);
        delete fields._id;
        update = { $set: fields, $setOnInsert: { _id: doc._id } };
      }
      update.$setOnInsert = Object.assign({}, update.$setOnInsert, { srvCreated: doc.srvModified });
      // An entry sent again for a reading that was deleted (isValid: false)
      // stores it again, as a v1 treatment, a v3 POST and an entry after a
      // hard delete all do.
      if (!Object.prototype.hasOwnProperty.call(doc, 'isValid')) {
        update.$unset = { isValid: '' };
      }

      return {
        updateOne: {
          filter: query,
          update: update,
          upsert: true
        }
      };
    });

    // An entry that updated a stored one (same sysTime and type) is answered
    // with the stored entry's _id, not the _id it was sent with or none, so
    // every item in the response names the record it is stored as. One read
    // for the whole batch, and only when some entry matched.
    async function assignStoredIds (ops, upsertedIds) {
      var matched = [];
      ops.forEach(function (op, index) {
        var filter = op.updateOne.filter;
        if (!Object.prototype.hasOwnProperty.call(upsertedIds, index) && filter.sysTime && filter.type) {
          matched.push(index);
        }
      });
      if (matched.length === 0) return;

      var key = function (sysTime, type) { return sysTime + '\u0000' + type; };
      var stored = await api().find(
        { $or: matched.map(function (index) { return ops[index].updateOne.filter; }) }
        , { projection: { _id: 1, sysTime: 1, type: 1 } }
      ).toArray();
      var byKey = {};
      stored.forEach(function (entry) { byKey[key(entry.sysTime, entry.type)] = entry._id; });
      matched.forEach(function (index) {
        var filter = ops[index].updateOne.filter;
        var id = byKey[key(filter.sysTime.$eq, filter.type.$eq)];
        if (id !== undefined) docs[index]._id = id;
      });
    }

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
      var upserted = (bulkResult && bulkResult.upsertedIds) || {};
      Object.keys(upserted).forEach(function(index) {
        docs[index]._id = upserted[index];
        docs[index].srvCreated = docs[index].srvModified;
      });

      try {
        await assignStoredIds(bulkOps, upserted);
      } catch (err) {
        // The entries are stored; a failed read-back leaves their _id as sent.
        console.error('Problem reading back stored entry ids', err);
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
        if (typeof fn === 'function') fn(err, docs);
        return;
      }
      if (typeof fn === 'function') fn(null, result);
    });
  }

  function getEntry (id, fn) {
    return runWithCallback(function () {
      // 15.0.6 and earlier stored a 24-hex _id as the string itself; match
      // an entry stored either way.
      return api().findOne(softDeleted.visible({ "_id": idForms.isHexId(id) ? { $in: idForms.idForms(id) } : new ObjectId(id) }));
    }, fn);
  }

  // Reads leave out deleted records (isValid: false; see soft-deleted).
  function query_for (opts) {
    return softDeleted.visible(stored_query_for(opts), opts);
  }

  // Every stored record the query names, deleted or not: what DELETE removes.
  function stored_query_for (opts) {
    // Build queryOpts inside function to access env.uuidHandling
    var queryOpts = {
      collection: 'entries'
      , useEpoch: true
      , uuidHandling: env.uuidHandling
    };
    var asked = opts && opts.find && opts.find._id;
    // find[_id]=<hex> (also used by DELETE /entries/:id) comes back as an
    // ObjectId; also match an entry stored with the same id as a string, as
    // 15.0.6 and earlier stored a 24-hex _id.
    return idForms.matchEitherForm(find_options(opts, queryOpts), asked);
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
    if (doc._id && typeof doc._id === 'string' && !idForms.isHexId(doc._id)) {
      delete doc._id;
    }
    
    // Standard CGM dedup: sysTime + type (one reading per timestamp per type)
    if (doc.sysTime && doc.type) {
      return { sysTime: { $eq: doc.sysTime }, type: { $eq: doc.type } };
    }
    // Never use the submitted document itself as a MongoDB selector. A fresh
    // server id makes the fallback an insert-only upsert and prevents nested
    // values such as {$ne: null} from becoming query operators.
    if (!(doc._id instanceof ObjectId)) {
      doc._id = new ObjectId();
    }
    return { _id: { $eq: doc._id } };
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
    idForms.dropEmptyId(doc);
    // REQ-SYNC-072: Only handle UUID values in _id field
    // Scope: ONLY the _id field when value is a valid UUID
    if (typeof doc._id === 'string' && !idForms.isHexId(doc._id)) {
      // Non-ObjectId string in _id (UUID format)
      // Only move to identifier when UUID_HANDLING is enabled
      if (env.uuidHandling && !doc.identifier) {
        doc.identifier = doc._id;
      }
      // Always delete invalid _id so server generates ObjectId
      delete doc._id;
    } else if (Object.prototype.hasOwnProperty.call(doc, '_id') && doc._id !== null && doc._id !== '') {
      // Convert valid ObjectId strings to ObjectId objects
      doc._id = idForms.toStoredId(doc._id);
    }
  }

  return api;
}

// expose module
storage.storage = storage;
module.exports = storage;
