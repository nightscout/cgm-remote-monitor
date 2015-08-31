'use strict';

function storage (collection, ctx) {
   var ObjectID = require('mongodb').ObjectID;

  function create (obj, fn) {
    obj.created_at = (new Date( )).toISOString( );
    api().insert(obj, function (err, doc) {
      fn(null, doc);
    });
  }

  function save (obj, fn) {
    obj._id = new ObjectID(obj._id);
    if (!obj.created_at) {
      obj.created_at = (new Date( )).toISOString( );
    }
    api().save(obj, function (err) {
      //id should be added for new docs
      fn(err, obj);
    });
  }

  function list (fn) {
    return api( ).find({ }).sort({validfrom: -1}).toArray(fn);
  }

  function last (fn) {
    return api().find().sort({validfrom: -1}).limit(1).toArray(fn);
  }

  function api () {
    return ctx.store.db.collection(collection);
  }
  
  api.list = list;
  api.create = create;
  api.save = save;
  api.last = last;
  api.indexedFields = ['validfrom'];
  return api;
}

module.exports = storage;
