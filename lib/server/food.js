'use strict';

const writeStep = require('../storage/write-step');
const writeIntent = require('../storage/write-intent');

const READ_OPTIONS = require('../storage/mongo-read-options');

function storage (env, ctx) {
  var runWithCallback = require('../storage/run-with-callback');
  var purifyForStorage = require('./storage-purifier');
  var quickpick = require('../food/quickpick');
  var softDeleted = require('./soft-deleted');
  var reads = require('./storage-reads');

  // Writes go through the write step (lib/storage/write-intent.js), which
  // holds the rules this module applied itself: the `_id` form, the target by
  // _id, srvCreated/srvModified (srv-dates) and the removal of a string-form
  // twin (object-id-forms). Purification and created_at stay here.
  function step ( ) {
    return writeIntent.forCollectionIntent(store, 'food', 'v1/internal', { env: env, bus: ctx.bus });
  }

  // A batch's documents, each with the _id it was stored under: the
  // upserted _id for a new record, as the driver reported it.
  function storedIds (docs, result) {
    result.items.forEach(function (item) {
      if (item.outcome === 'inserted') docs[item.index]._id = item._id;
    });
    return docs;
  }

  function create (docs, fn) {
    // Normalize to array for consistent handling (allows direct storage calls with single objects)
    if (!Array.isArray(docs)) {
      docs = [docs];
    }

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

    // A create stamps created_at with the server's time (as it always has).
    // The step stores a 24-hex string _id as the ObjectId it names, as
    // treatments do, so PUT, DELETE and find[_id] find the record that was
    // created, and replaces a record already stored under that _id.
    docs.forEach(function (doc) {
      doc.created_at = (new Date()).toISOString();
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
      } catch (err) {
        console.error('Problem upserting food batch', err);
        throw err;
      }

      return writeIntent.resendReplies(storedIds(docs, result), result.items, sent);
    }, function (err, result) {
      if (err) {
        if (typeof fn === 'function') fn(err, []);
        return;
      }
      if (typeof fn === 'function') fn(null, result);
    });
  }

  function save (docs, fn) {
    // Normalize to array for consistent handling
    if (!Array.isArray(docs)) {
      docs = [docs];
    }

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

    docs.forEach(function (doc) {
      if (!doc.created_at) {
        doc.created_at = (new Date()).toISOString();
      }
    });

    // Started here, not inside runWithCallback's microtask: the step gives
    // each document its _id before its first await, so the documents carry
    // their _id when this call returns, as they did.
    var writing = step().write({ op: 'update', docs: docs });

    return runWithCallback(async function () {
      var result;

      try {
        result = await writing;
      } catch (err) {
        console.error('Problem saving food batch', err);
        throw err;
      }

      return storedIds(docs, result);
    }, function (err, result) {
      if (err) {
        if (typeof fn === 'function') fn(err, []);
        return;
      }
      if (typeof fn === 'function') fn(null, result);
    });
  }

  function list (fn) {
    return runWithCallback(function () {
      // Reads leave out deleted records (isValid: false; see soft-deleted).
      return reads.find(store(), reads.toFilter(softDeleted.visible({ })), { readOptions: READ_OPTIONS });
    }, fn);
  }

  function listquickpicks (fn) {
    // `hidden` and `position` have no settled type on disk: the built-in
    // editor form-encodes, so it writes the STRINGS 'false' and '3', while a
    // JSON client writes a boolean and a number. See lib/food/quickpick.js.
    //
    // The old filter was { hidden: 'false' } - the string only - so it hid
    // every quick pick a JSON client had ever written, and every record
    // saved before the field existed. Ask the question the other way round:
    // not-hidden is anything that is not one of the two spellings of true,
    // which $nin also satisfies for a missing field.
    //
    // The sort has to happen here rather than in the query, because a
    // lexicographic sort over stored strings puts '10' between '1' and '2'.
    return runWithCallback(function () {
      return reads.find(store()
        , reads.toFilter({ $and: [ { 'type': 'quickpick' }, { 'hidden': { $nin: [ true, 'true' ] } }, softDeleted.notDeleted() ] })
        , { readOptions: READ_OPTIONS })
        .then(function (records) { return records.sort(quickpick.byPosition); });
    }, fn);
  }

  function listregular (fn) {
    return runWithCallback(function () {
      return reads.find(store(), reads.toFilter(softDeleted.visible({ 'type': 'food' })), { readOptions: READ_OPTIONS });
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
  // (lib/server/storage-reads.js, lib/server/storage-writes.js).
  function store ( ) {
    return reads.collection(ctx, env, env.food_collection, 'food');
  }

  // The handle tests seed through.
  function api ( ) {
    return writeStep.collection(ctx.store.collection(env.food_collection), {name: 'food',
      source: 'v1/internal', bus: ctx.bus});
  }

  api.list = list;
  api.listquickpicks = listquickpicks;
  api.listregular = listregular;
  api.create = create;
  api.save = save;
  api.remove = remove;
  api.indexedFields = ['type','position','hidden'];
  return api;
}

module.exports = storage;
