'use strict';

function storage (env, ctx) {
   var ObjectID = require('mongodb').ObjectId;
  var runWithCallback = require('../storage/run-with-callback');

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
      return fn(null, []);
    }

    // Build bulkWrite operations for batch upsert
    var bulkOps = docs.map(function(doc) {
      doc.created_at = (new Date()).toISOString();
      var query = (doc.created_at && doc._id) ? { _id: doc._id, created_at: doc.created_at } : doc;
      return {
        replaceOne: {
          filter: query,
          replacement: doc,
          upsert: true
        }
      };
    });

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
        fn(err, []);
        return;
      }
      fn(null, result);
    });
  }

  function save (docs, fn) {
    // Normalize to array for consistent handling
    if (!Array.isArray(docs)) {
      docs = [docs];
    }

    if (docs.length === 0) {
      return fn(null, []);
    }

    // Build bulkWrite operations for batch upsert
    var bulkOps = docs.map(function(doc) {
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
        fn(err, []);
        return;
      }
      fn(null, result);
    });
  }

  function list (fn) {
    return runWithCallback(function () {
      return api().find({ }).toArray();
    }, fn);
  }
  
  function listquickpicks (fn) {
    return runWithCallback(function () {
      return api().find({ $and: [ { 'type': 'quickpick'} , { 'hidden' : 'false' } ] }).sort({'position': 1}).toArray();
    }, fn);
  }
  
  function listregular (fn) {
    return runWithCallback(function () {
      return api().find( { 'type': 'food'} ).toArray();
    }, fn);
  }
  
  function remove (_id, fn) {
    var objId = new ObjectID(_id);
    return runWithCallback(function () {
      return api().deleteOne({ '_id': objId });
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
