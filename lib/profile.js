'use strict';

function storage (collection, ctx) {
   var ObjectID = require('mongodb').ObjectID;

  function create (obj, fn) {
    obj.created_at = (new Date( )).toISOString( );
    api().insert(obj, function (err, doc) {
      fn(null, doc);
    });
    ctx.bus.emit('data-received');
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
    ctx.bus.emit('data-received');
  }

  function list (fn) {
    return api( ).find({ }).sort({startDate: -1}).toArray(fn);
  }

  function last (fn) {
    return api().find().sort({startDate: -1}).limit(1).toArray(fn);
  }

  function remove (_id, fn) {
    api( ).remove({ '_id': new ObjectID(_id) }, fn);

    ctx.bus.emit('data-received');
  }

  function api () {
    return ctx.store.db.collection(collection);
  }
  
  api.list = list;
  api.create = create;
  api.save = save;
  api.remove = remove;
  api.last = last;
  api.indexedFields = ['startDate'];
  return api;
}

module.exports = storage;
