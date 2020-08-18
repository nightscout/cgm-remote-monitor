'use strict';

function storage (env, ctx) {
   var ObjectID = require('mongodb').ObjectID;

  function create (obj, fn) {
    obj.created_at = (new Date( )).toISOString( );
    api().insert(obj, function (err, doc) {
      if (err != null && err.message) {
        console.log('Data insertion error', err.message);
        fn(err.message, null);
        return;
      }
      fn(null, doc.ops);
    });
  }

  function save (obj, fn) {
    try {
      obj._id = new ObjectID(obj._id);
    } catch (err){
      console.error(err);
      obj._id = new ObjectID();
    }
    obj.created_at = (new Date( )).toISOString( );
    api().save(obj, function (err, doc) {
      fn(err, doc);
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
    return api( ).remove({ '_id': objId }, fn);
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
