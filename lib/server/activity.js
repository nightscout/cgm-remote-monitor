'use strict';

const writeStep = require('../storage/write-step');

const READ_OPTIONS = require('../storage/mongo-read-options');

var find_options = require('./query');
var runWithCallback = require('../storage/run-with-callback');
var purifyForStorage = require('./storage-purifier');
var reads = require('./storage-reads');
var writes = require('./storage-writes');


function storage (env, ctx) {
   var ObjectID = require('mongodb').ObjectId;
  var idForms = require('./object-id-forms');

  function normalizeObjectId(id) {
    try {
      return new ObjectID(id);
    } catch {
      return new ObjectID();
    }
  }

  function create (docs, fn) {
    if (docs.length === 0) {
      if (typeof fn === 'function') return fn(null, []);
      return Promise.resolve([]);
    }

    try {
      purifyForStorage(ctx, docs);
    } catch (err) {
      if (typeof fn === 'function') return fn(err, []);
      return Promise.reject(err);
    }

    // Build bulkWrite operations for batch upsert
    var submitted = [];
    var bulkOps = docs.map(function(doc) {
      if (!Object.prototype.hasOwnProperty.call(doc, 'created_at')) {
        doc.created_at = (new Date()).toISOString();
      }
      submitted.push(doc._id);
      if (!doc._id) {
        doc._id = new ObjectID();
      }
      // Store a 24-hex string _id as the ObjectId it names, as treatments
      // do, so PUT, DELETE and find[_id] find the record that was created.
      doc._id = idForms.toStoredId(doc._id);
      var query = { _id: { $eq: doc._id } };
      return {
        replaceOne: {
          filter: query,
          replacement: doc,
          upsert: true
        }
      };
    });
    idForms.withStaleStringsRemoved(bulkOps, submitted);

    return runWithCallback(async function () {
      var bulkResult;

      try {
        bulkResult = await writes.bulk(store(), bulkOps, { ordered: true });
      } catch (err) {
        console.error('Problem upserting activity batch', err);
        throw err;
      }

      // Assign _ids from upserted results
      if (bulkResult && bulkResult.upsertedIds) {
        Object.keys(bulkResult.upsertedIds).forEach(function(index) {
          docs[index]._id = bulkResult.upsertedIds[index];
        });
      }

      return docs;
    }, function (err, result) {
      if (err) {
        if (typeof fn === 'function') fn(err, []);
        return;
      }
      if (typeof fn === 'function') fn(null, result);
    });
  }


  function save (obj, fn) {
    try {
      purifyForStorage(ctx, obj);
    } catch (err) {
      if (typeof fn === 'function') return fn(err, obj);
      return Promise.reject(err);
    }

    var stale = idForms.staleStringForms([obj._id]);
    obj._id = normalizeObjectId(obj._id);
    if (!Object.prototype.hasOwnProperty.call(obj, 'created_at')) {
      obj.created_at = (new Date( )).toISOString( );
    }
    return runWithCallback(async function () {
      await writes.replace(store(), { _id: obj._id }, obj, { upsert: true });
      if (stale.length > 0) {
        await writes.remove(store(), { _id: { $in: stale } });
      }
      return obj;
    }, fn);
  }

  function query_for (opts) {
    var asked = opts && opts.find && opts.find._id;
    // find[_id]=<hex> comes back as an ObjectId; also match a record stored
    // with the same id as a string.
    return idForms.matchEitherForm(find_options(opts, storage.queryOpts), asked);
  }

  function list(opts, fn) {
    // these functions, find, sort, and limit, are used to
    // dynamically configure the request, based on the options we've
    // been given

    // determine sort options
    function sort ( ) {
      return opts && opts.sort || {created_at: -1};
    }

    // Through the storage interface; count, sort and read options as before
    // (lib/server/storage-reads.js).
    return runWithCallback(function () {
      return reads.list(store( ), query_for(opts)
        , { sort: sort( ), count: opts && opts.count, readOptions: READ_OPTIONS });
    }, fn);
  }

  function remove (_id, fn) {
    // Remove the record whichever form its _id is stored in, and both forms
    // where an earlier edit left an ObjectId copy beside a string original.
    var filter = idForms.idFilter(_id);
    return runWithCallback(function () {
      return writes.remove(store(), { '_id': filter });
    }, fn);
  }

  // Reads and writes go through the storage interface, labelled 'v1/internal'
  // (lib/server/storage-reads.js, lib/server/storage-writes.js).
  function store ( ) {
    return reads.collection(ctx, env, env.activity_collection, 'activity');
  }

  // The handle tests seed through.
  function api ( ) {
    return writeStep.collection(ctx.store.collection(env.activity_collection), {name: 'activity',
      source: 'v1/internal', bus: ctx.bus});
  }

  api.list = list;
  api.create = create;
  api.query_for = query_for;
  api.save = save;
  api.remove = remove;
  api.indexedFields = ['created_at'];
  return api;
}

storage.queryOpts = {
  collection: 'activity'
  , dateField: 'created_at'
};

module.exports = storage;
