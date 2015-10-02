'use strict';


function storage (collection, storage) {
   var ObjectID = require('mongodb').ObjectID;

  function create (obj, fn) {
    obj.created_at = (new Date( )).toISOString( );
    api().insert(obj, function (err, doc) {
      fn(null, doc);
    });
  }

  function save (obj, fn) {
    obj._id = new ObjectID(obj._id);
    obj.created_at = (new Date( )).toISOString( );
    api().save(obj, function (err, doc) {
      fn(err, doc);
    });
  }

  function list (fn) {
    return api( ).find({ }).sort({validfrom: -1}).toArray(fn);
  }

  function last (fn) {
    return api().find().sort({validfrom: -1}).limit(1).toArray(fn);
  }

  function api () {
    return storage.pool.db.collection(collection);
  }
  
  api.list = list;
  api.create = create;
  api.save = save;
  api.last = last;
  api.indexedFields = indexedFields;
  return api;
}

var indexedFields = ['validfrom'];

module.exports = storage;
