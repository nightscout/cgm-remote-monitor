'use strict';

function storage (env, ctx) {
   var ObjectID = require('mongodb-legacy').ObjectId;

  function create (docs, fn) {
    // Normalize to array for consistent handling (allows direct storage calls with single objects)
    if (!Array.isArray(docs)) {
      docs = [docs];
    }

    var firstErr = null
      , numDocs = docs.length
      , totalCreated = 0;

    docs.forEach(function(doc) {
      doc.created_at = (new Date( )).toISOString( );
      var query = (doc.created_at && doc._id) ? { _id: doc._id, created_at: doc.created_at } : doc;
      api().replaceOne(query, doc, { upsert: true }, function(err, updateResults) {
        firstErr = firstErr || err;

        if (++totalCreated === numDocs) {
          fn(firstErr, docs);
        }
      });
    });
  }

  function save (obj, fn) {
    try {
      obj._id = new ObjectID(obj._id);
    } catch (err){
      console.error(err);
      obj._id = new ObjectID();
    }
    if (!obj.created_at) {
      obj.created_at = (new Date( )).toISOString( );
    }

    var query = (obj.created_at && obj._id) ? { _id: obj._id, created_at: obj.created_at } : obj;
    api().replaceOne(query, obj, { upsert: true }, function(err, updateResults) {
      fn(err, obj);
    });
  }

  function list (fn) {
    return api( ).find({ }).toArray(fn);
  }
  
  function listquickpicks (fn) {
    return api( ).find({ $and: [ { 'type': 'quickpick'} , { 'hidden' : 'false' } ] }).sort({'position': 1}).toArray(fn);
  }
  
  function listregular (fn) {
    return api( ).find( { 'type': 'food'} ).toArray(fn);
  }
  
  function remove (_id, fn) {
    var objId = new ObjectID(_id);
    return api( ).deleteOne({ '_id': objId }, fn);
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
