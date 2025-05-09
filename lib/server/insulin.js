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
    return api( ).find({ }).sort({name: -1}).toArray(fn);
  }

  function searchByName (name) {
    return api( ).find({"name": name}).sort({name: -1}).toArray();
  }

  function bolus (fn) {
    return api().find({"active": "bolus" }).limit(1).toArray(fn);
  }

  function basal (fn) {
    return api().find({"active": "basal" }).limit(1).toArray(fn);
  }

  function remove (_id, fn) {
    var objId = new ObjectID(_id);
    api( ).remove({ '_id': objId }, fn);

    ctx.bus.emit('data-received');
  }

  function api () {
    return ctx.store.collection(collection);
  }
  
  api.list = list;
  api.create = create;
  api.save = save;
  api.remove = remove;
  api.bolus = bolus;
  api.basal = basal;
  api.searchByName = searchByName;
  api.indexedFields = ['name'];
  return api;
}

module.exports = storage;
