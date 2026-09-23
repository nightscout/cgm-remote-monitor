'use strict';

function storage (env, ctx) {
   var ObjectID = require('mongodb').ObjectId;
  var idForms = require('./object-id-forms');
  var runWithCallback = require('../storage/run-with-callback');
  var purifyForStorage = require('./storage-purifier');
  var quickpick = require('../food/quickpick');

  function normalizeObjectId(id) {
    try {
      return new ObjectID(id);
    } catch (err) {
      return new ObjectID();
    }
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

    // Build bulkWrite operations for batch upsert
    var submitted = [];
    var bulkOps = docs.map(function(doc) {
      doc.created_at = (new Date()).toISOString();
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
        bulkResult = await api().bulkWrite(bulkOps, { ordered: true });
      } catch (err) {
        console.error('Problem upserting food batch', err);
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

    // Build bulkWrite operations for batch upsert
    var submitted = [];
    var bulkOps = docs.map(function(doc) {
      submitted.push(doc._id);
      doc._id = normalizeObjectId(doc._id);
      if (!doc.created_at) {
        doc.created_at = (new Date()).toISOString();
      }

      return {
        replaceOne: {
          filter: { _id: doc._id },
          replacement: doc,
          upsert: true
        }
      };
    });
    idForms.withStaleStringsRemoved(bulkOps, submitted);

    return runWithCallback(async function () {
      var bulkResult;

      try {
        bulkResult = await api().bulkWrite(bulkOps, { ordered: true });
      } catch (err) {
        console.error('Problem saving food batch', err);
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

  function list (fn) {
    return runWithCallback(function () {
      return api().find({ }).toArray();
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
      return api()
        .find({ $and: [ { 'type': 'quickpick' }, { 'hidden': { $nin: [ true, 'true' ] } } ] })
        .toArray()
        .then(function (records) { return records.sort(quickpick.byPosition); });
    }, fn);
  }
  
  function listregular (fn) {
    return runWithCallback(function () {
      return api().find( { 'type': 'food'} ).toArray();
    }, fn);
  }
  
  function remove (_id, fn) {
    // Remove the record whichever form its _id is stored in, and both forms
    // where an earlier edit left an ObjectId copy beside a string original.
    var forms = idForms.idForms(_id);
    return runWithCallback(function () {
      return api().deleteMany({ '_id': { $in: forms } });
    }, fn);
  }



  function api ( ) {
    return ctx.store.collection(env.food_collection);
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
