'use strict';

const writeStep = require('../storage/write-step');
const writeIntent = require('../storage/write-intent');

const READ_OPTIONS = require('../storage/mongo-read-options');

var find_options = require('./query');
var runWithCallback = require('../storage/run-with-callback');
var purifyForStorage = require('./storage-purifier');
var reads = require('./storage-reads');
var writeItems = require('./write-items');


function storage (env, ctx) {
  var idForms = require('./object-id-forms');

  // Writes go through the write step (lib/storage/write-intent.js), which
  // holds the rules this module applied itself: the `_id` form, the target by
  // _id and the removal of a string-form twin (object-id-forms). Activity has
  // no server dates. Purification and created_at stay here.
  function step ( ) {
    return writeIntent.forCollectionIntent(store, 'activity', 'v1/internal', { env: env, bus: ctx.bus });
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

    // created_at is kept when the caller sent one. The step stores a 24-hex
    // string _id as the ObjectId it names, as treatments do, so PUT, DELETE
    // and find[_id] find the record that was created, and replaces a record
    // already stored under that _id.
    docs.forEach(function (doc) {
      if (!Object.prototype.hasOwnProperty.call(doc, 'created_at')) {
        doc.created_at = (new Date()).toISOString();
      }
    });

    // Started here, not inside runWithCallback's microtask: the step gives
    // each document its _id before its first await, so the documents carry
    // their _id when this call returns, as they did.
    // Each record as sent, for the slot of one WRITE_RESEND=refuse refuses.
    var sent = docs.map(function (doc) { return Object.assign({}, doc); });
    var writing = step().write({ op: 'create', docs: docs });

    return runWithCallback(async function () {
      var result;

      try {
        result = await writing;
        writeItems.record(docs, result);
      } catch (err) {
        console.error('Problem upserting activity batch', err);
        throw err;
      }

      // A new record's _id as the driver reported it.
      result.items.forEach(function (item) {
        if (item.outcome === 'inserted') docs[item.index]._id = item._id;
      });
      return writeIntent.resendReplies(docs, result.items, sent);
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

    if (!Object.prototype.hasOwnProperty.call(obj, 'created_at')) {
      obj.created_at = (new Date( )).toISOString( );
    }
    // Started here, as create's is: obj carries its _id (new ObjectId(_id),
    // or a fresh one) when this call returns. The step replaces by _id and
    // then removes a string-form twin of a 24-hex _id in a call of its own.
    var writing = step().write({ op: 'update', docs: [obj] });
    return runWithCallback(async function () {
      await writing;
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
    // The callback gets the storage interface's reply, as before.
    return runWithCallback(async function () {
      return (await step().write({ op: 'delete', target: { _id: _id } })).adapter;
    }, fn);
  }

  // Reads and writes go through the storage interface, labelled 'v1/internal'
  // (lib/server/storage-reads.js; writes through lib/storage/write-intent.js).
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
