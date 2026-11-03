// The pre-move lib/server/entries.js at dev db3b9e4e, kept as the reference the
// write step is compared with (tests/write-intent.v1-collections.test.js).
// Only the require paths differ from that file. Not loaded by the server.
'use strict';

const writeStep = require('../../../lib/storage/write-step');

const READ_OPTIONS = require('../../../lib/storage/mongo-read-options');

const {PassThrough, Writable} = require('node:stream');
var find_options = require('../../../lib/server/query');
var ObjectId = require('mongodb').ObjectId;
var moment = require('moment');
var runWithCallback = require('../../../lib/storage/run-with-callback');
var purifyForStorage = require('../../../lib/server/storage-purifier');
var reads = require('../../../lib/server/storage-reads');
var writes = require('../../../lib/server/storage-writes');
var srvDates = require('../../../lib/server/srv-dates');
var softDeleted = require('../../../lib/server/soft-deleted');
var mergePatch = require('../../../lib/server/merge-patch');

// REQ-SYNC-072: the 24-hex _id rule lives in object-id-forms.
var idForms = require('../../../lib/server/object-id-forms');

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
      var stat = await writes.remove(store(), stored_query_for(opts));
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

  // Retain the writable stream interface for callers outside the HTTP array
  // path, using native object streams. The map intentionally changes nothing.
  function map () {
    return new PassThrough({objectMode: true});
  }

  function persist (fn) {
    const records = [];
    let completed = false;
    function done(err, result) {
      if (completed) return;
      completed = true;
      fn(err, result);
    }
    return new Writable({
      objectMode: true,
      write(record, encoding, next) {records.push(record); next();},
      final(next) {
        create(records, function (err, result) {done(err, result); next();});
      },
      destroy(err, next) {
        if (!completed) done(err || new Error('destroyed before end'), records);
        next(err);
      }
    });
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

    var insertOnly = new Set();

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

      // Build upsert query: sysTime+type here; an entry whose identifier is
      // already stored is matched on it instead (matchStoredIdentifiers).
      var sentId = doc._id;
      var query = upsertQueryFor(doc);
      // A selector on an _id the server just generated can only insert.
      if (query._id && doc._id !== sentId) insertOnly.add(doc);

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

    // An entry that carries an identifier already stored, or one an earlier
    // entry in this batch carries, updates that entry, as a v1 treatment
    // does: the identifier names the reading, so a re-send at a corrected
    // time or from another device replaces it instead of adding a second
    // one. Any other entry keeps the sysTime+type match, including one whose
    // identifier is new, so readings that were merged by time still are. One
    // indexed read per batch, only for a batch that carries identifiers.
    async function matchStoredIdentifiers (ops) {
      var identifiers = [];
      docs.forEach(function (doc) {
        if (hasIdentifier(doc) && identifiers.indexOf(doc.identifier) === -1) identifiers.push(doc.identifier);
      });
      if (identifiers.length === 0) return;

      var stored = await reads.findAll(store()
        , identifierQueryFor({ $in: identifiers })
        , { projection: { _id: 1, identifier: 1 } });
      var known = {};
      stored.forEach(function (entry) {
        if (typeof entry.identifier === 'string') known[entry.identifier] = true;
        if (env.uuidHandling && typeof entry._id === 'string') known[entry._id] = true;
      });

      docs.forEach(function (doc, index) {
        if (!hasIdentifier(doc)) return;
        if (Object.prototype.hasOwnProperty.call(known, doc.identifier)) {
          ops[index].updateOne.filter = identifierQueryFor({ $eq: doc.identifier });
          // Matched on a stored identifier, so no longer an insert-only selector.
          insertOnly.delete(doc);
        }
        // A later entry with the same identifier updates this one.
        known[doc.identifier] = true;
      });
    }

    // An entry that updated a stored one (same sysTime and type, or the same
    // identifier) is answered with the stored entry's _id, not the _id it was
    // sent with or none, so every item in the response names the record it is
    // stored as. One read for the whole batch, and only when some entry matched.
    async function assignStoredIds (ops, upsertedIds) {
      var matched = [];
      var byIdentifier = [];
      ops.forEach(function (op, index) {
        var filter = op.updateOne.filter;
        if (Object.prototype.hasOwnProperty.call(upsertedIds, index)) return;
        if (filter.sysTime && filter.type) {
          matched.push(index);
        } else if (filter.identifier || filter.$or) {
          byIdentifier.push(index);
        }
      });

      if (byIdentifier.length > 0) {
        var identified = await reads.findAll(store()
          , identifierQueryFor({ $in: byIdentifier.map(function (index) { return docs[index].identifier; }) })
          , { projection: { _id: 1, identifier: 1 } });
        var byValue = {};
        identified.forEach(function (entry) {
          if (env.uuidHandling && typeof entry._id === 'string') byValue[entry._id] = entry._id;
        });
        identified.forEach(function (entry) {
          if (typeof entry.identifier === 'string') byValue[entry.identifier] = entry._id;
        });
        byIdentifier.forEach(function (index) {
          var id = byValue[docs[index].identifier];
          if (id !== undefined) docs[index]._id = id;
        });
      }

      if (matched.length === 0) return;

      var key = function (sysTime, type) { return sysTime + '\u0000' + type; };
      var stored = await reads.findAll(store()
        , { $or: matched.map(function (index) { return ops[index].updateOne.filter; }) }
        , { projection: { _id: 1, sysTime: 1, type: 1 } });
      var byKey = {};
      stored.forEach(function (entry) { byKey[key(entry.sysTime, entry.type)] = entry._id; });
      matched.forEach(function (index) {
        var filter = ops[index].updateOne.filter;
        var id = byKey[key(filter.sysTime.$eq, filter.type.$eq)];
        if (id !== undefined) docs[index]._id = id;
      });
    }

    // An entry re-sent for a reading already stored is merged into it as a
    // JSON Merge Patch (RFC 7386, write-contract Q1b, decided 2026-10-26): a
    // field sent as null is removed, at any depth, and an object merges into
    // the stored object. A plain $set already is that merge for a body
    // without a null or an object member, so only a batch with such a member
    // reads the entries it names first, and only the operations that match
    // a stored entry, or an earlier entry of the same batch, change. An
    // entry that is created stores what it is sent, nulls included; one whose
    // selector is an _id the server just generated can only be created, so
    // it never asks for the read.
    async function mergeMatched (ops) {
      var candidates = [];
      docs.forEach(function (doc, index) {
        if (!insertOnly.has(doc) && mergePatch.differsFromSet(doc)) candidates.push(index);
      });
      if (candidates.length === 0) return;

      // The selector an operation uses: sysTime+type, a stored identifier
      // (matchStoredIdentifiers, which runs first), or a generated _id.
      function keyOf (filter) {
        if (filter.sysTime && filter.type) return 't:' + filter.sysTime.$eq + '\u0000' + filter.type.$eq;
        if (filter.identifier) return 'd:' + filter.identifier.$eq;
        if (filter.$or) return 'd:' + filter.$or[0].identifier.$eq;
        return 'i:' + String(filter._id.$eq);
      }
      // Every selector a record answers to.
      function keysOf (entry) {
        var keys = ['t:' + entry.sysTime + '\u0000' + entry.type];
        if (entry._id !== undefined) keys.push('i:' + String(entry._id));
        if (typeof entry.identifier === 'string') keys.push('d:' + entry.identifier);
        if (env.uuidHandling && typeof entry._id === 'string') keys.push('d:' + entry._id);
        return keys;
      }

      // What each selector names as the batch is applied in order: the stored
      // entry, or the entry an earlier operation of the batch writes. Each
      // record is one box, so a write through one selector is seen through
      // the others (an entry merged on its identifier, then re-sent for the
      // same sysTime and type, say).
      var state = new Map();
      function register (box) {
        keysOf(box.doc).forEach(function (key) {
          if (!state.has(key)) state.set(key, box);
        });
      }
      var stored = await reads.findAll(store(), { $or: ops.map(function (op) { return op.updateOne.filter; }) });
      stored.forEach(function (entry) { register({ doc: entry }); });

      var candidate = new Set(candidates);
      ops.forEach(function (op, index) {
        var key = keyOf(op.updateOne.filter);
        var box = state.get(key);
        var fields = op.updateOne.update.$set;
        if (!box) {
          box = { doc: Object.assign({}, op.updateOne.update.$setOnInsert, fields) };
          state.set(key, box);
          register(box);
          return;
        }
        if (!candidate.has(index)) {
          box.doc = Object.assign({}, box.doc, fields);
          register(box);
          return;
        }
        var parts = mergePatch.update(box.doc, fields);
        var update = mergePatch.toMongo(parts);
        update.$setOnInsert = op.updateOne.update.$setOnInsert;
        if (op.updateOne.update.$unset) {
          update.$unset = Object.assign({}, op.updateOne.update.$unset, update.$unset);
        }
        op.updateOne.update = update;
        box.doc = mergePatch.assignInto(Object.assign({}, box.doc), parts);
        register(box);
      });
    }

    return runWithCallback(async function () {
      var bulkResult;

      try {
        // Resolve each entry's target first (identifier, else sysTime+type),
        // then compute the merge against that target.
        await matchStoredIdentifiers(bulkOps);
        await mergeMatched(bulkOps);
        // Use bulkWrite for batch upsert
        bulkResult = await writes.bulk(store(), bulkOps, { ordered: true });
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
    return runWithCallback(async function () {
      // 15.0.6 and earlier stored a 24-hex _id as the string itself; match
      // an entry stored either way. One document, or null, as findOne gave.
      var storage = store();
      var docs = await reads.find(storage, reads.toFilter(softDeleted.visible({ "_id": idForms.isHexId(id) ? { $in: idForms.idForms(id) } : new ObjectId(id) }))
        , { limit: 1 });
      return docs.length ? docs[0] : null;
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

  // Reads and writes go through the storage interface, labelled 'v1/internal'
  // (lib/server/storage-reads.js, lib/server/storage-writes.js).
  function store () {
    return reads.collection(ctx, env, env.entries_collection, 'entries');
  }

  // closure to represent the API; the handle it returns is
  // what tests seed through. lib/server/aggregate.js counts through store().
  function api () {
    // obtain handle usable for querying the collection associated
    // with these records
    return writeStep.collection(ctx.store.collection(env.entries_collection), {name: 'entries',
      source: 'v1/internal', bus: ctx.bus});
  }

  // Expose all the useful functions
  api.list = list;
  api.map = map;
  api.create = create;
  api.remove = remove;
  api.persist = persist;
  api.query_for = query_for;
  api.getEntry = getEntry;
  api.aggregate = require('../../../lib/server/aggregate')(api, store);
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
   * For CGM entries, sysTime+type is the dedup key: one SGV reading per
   * timestamp, whatever its source UUID. The one exception is an entry whose
   * identifier is already stored, which create() matches on that identifier.
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

  // A client identifier the entry can be matched on: a non-empty string.
  // Any other value is stored as sent and the entry is matched by time.
  function hasIdentifier (doc) {
    return typeof doc.identifier === 'string' && doc.identifier !== '';
  }

  // The stored entries an identifier names. Under UUID_HANDLING this also
  // matches an entry stored with the value as its _id (15.0.6 and earlier),
  // as for v1 treatments.
  function identifierQueryFor (condition) {
    if (env.uuidHandling) {
      return { $or: [{ identifier: condition }, { _id: condition }] };
    }
    return { identifier: condition };
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
