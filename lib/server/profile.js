'use strict';

var find_options = require('./query');
var consts = require('../constants');

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
    return api( ).find({ }).limit(consts.PROFILES_DEFAULT_COUNT).sort({startDate: -1}).toArray(fn);
  }

  function list_query (opts, fn) {

    storage.queryOpts = {
      walker: {}
      , dateField: 'startDate'
    };

    function limit () {
        if (opts && opts.count) {
            return this.limit(parseInt(opts.count));
        }
        return this;
    }

    return limit.call(api()
      .find(query_for(opts))
      .sort(opts && opts.sort && query_sort(opts) || { startDate: -1 }), opts)
      .toArray(fn);
  }

  function query_for (opts) {
      var retVal = find_options(opts, storage.queryOpts);
      return retVal;
  }

  function query_sort (opts) {
    if (opts && opts.sort) {
      var sortKeys = Object.keys(opts.sort);

      for (var i = 0; i < sortKeys.length; i++) {
        if (opts.sort[sortKeys[i]] == '1') {
          opts.sort[sortKeys[i]] = 1;
        }
        else {
          opts.sort[sortKeys[i]] = -1;
        }
      }
      return opts.sort;
    }
  }


  function last (fn) {
    return api().find().sort({startDate: -1}).limit(1).toArray(fn);
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
  api.list_query = list_query;
  api.create = create;
  api.save = save;
  api.remove = remove;
  api.last = last;
  api.indexedFields = ['startDate'];
  return api;
}

module.exports = storage;
