'use strict';

const writeStep = require('../storage/write-step');
const writeIntent = require('../storage/write-intent');

const READ_OPTIONS = require('../storage/mongo-read-options');

const {PassThrough, Writable} = require('node:stream');
var find_options = require('./query');
var ObjectId = require('mongodb').ObjectId;
var runWithCallback = require('../storage/run-with-callback');
var purifyForStorage = require('./storage-purifier');
var reads = require('./storage-reads');
var softDeleted = require('./soft-deleted');

// REQ-SYNC-072: the 24-hex _id rule lives in object-id-forms.
var idForms = require('./object-id-forms');

/**********\
 * Entries
 * Encapsulate persistent storage of sgv entries.
\**********/

function storage (env, ctx) {

  // Writes go through the write step (lib/storage/write-intent.js), which
  // holds the rules this module applied itself: the `_id` form
  // (REQ-SYNC-072), sysTime, the target (sysTime + type, or a stored
  // identifier: ID-SIMPLE-MATCH), server dates, the merge of a re-send (Q1b)
  // and the stored _id a matched entry is answered with. Purification, the
  // type check and every bus emission stay here.
  function step ( ) {
    return writeIntent.forCollection(store, 'entries', 'v1/internal', { env: env });
  }

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
      var stat = (await step().write({ op: 'delete', target: { filter: stored_query_for(opts) } })).adapter;
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

    // Each entry's _id form, sysTime, target and srvModified now, before the
    // first await, as before; the write and its read-backs in the step.
    var planned = step().plan({ op: 'create', docs: docs });

    return runWithCallback(async function () {
      var result;

      try {
        // The step resolves each entry's target first (identifier, else
        // sysTime+type), then computes the merge against that target, then
        // writes the batch.
        result = await step().write(planned);
      } catch (err) {
        console.error('Problem upserting entries batch', err);
        throw err;
      }

      if (result.readBackError !== undefined) {
        // The entries are stored; a failed read-back leaves their _id as sent.
        console.error('Problem reading back stored entry ids', result.readBackError);
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
  // (lib/server/storage-reads.js; writes through lib/storage/write-intent.js).
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
  api.aggregate = require('./aggregate')(api, store);
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
 
  return api;
}

// expose module
storage.storage = storage;
module.exports = storage;
