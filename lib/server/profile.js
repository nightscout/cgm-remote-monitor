'use strict';

var find_options = require('./query');
var consts = require('../constants');
var runWithCallback = require('../storage/run-with-callback');

function storage (collection, ctx) {
   var ObjectID = require('mongodb').ObjectId;

  function create (objOrArray, fn) {
    // Normalize to array (supports both single object and array inputs)
    var docs = Array.isArray(objOrArray) ? objOrArray : [objOrArray];

    if (docs.length === 0) {
      fn(null, []);
      ctx.bus.emit('data-received');
      return Promise.resolve([]);
    }

    // Add created_at to each document
    docs.forEach(function(doc) {
      if (!doc.created_at) {
        doc.created_at = (new Date()).toISOString();
      }
    });

    const promise = runWithCallback(async function () {
      const result = await api().insertMany(docs);
      if (result && result.insertedIds) {
        Object.keys(result.insertedIds).forEach(function (index) {
          if (!docs[index]._id) {
            docs[index]._id = result.insertedIds[index];
          }
        });
      }
      return docs;
    }, function (err, result) {
      if (err) {
        console.log('Error saving profile data', docs, err);
        fn(err);
        return;
      }
      fn(null, result);
    });

    ctx.bus.emit('data-received');
    return promise;
  }

  function save (obj, fn) {
    try {
      obj._id = new ObjectID(obj._id);
    } catch (err) {
      obj._id = new ObjectID();
    }
    if (!Object.prototype.hasOwnProperty.call(obj, 'created_at')) {
      obj.created_at = (new Date( )).toISOString( );
    }
    // Match existing profiles by _id only. The profile editor rewrites created_at on save.
    const promise = runWithCallback(async function () {
      await api().replaceOne({ _id: obj._id }, obj, { upsert: true });
      return obj;
    }, fn);

    ctx.bus.emit('data-received');
    return promise;
  }

  function list (fn, count) {
    const limit = count !== null ? count : Number(consts.PROFILES_DEFAULT_COUNT);
    return runWithCallback(function () {
      return api().find({ }).limit(limit).sort({startDate: -1}).toArray();
    }, fn);
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

    return runWithCallback(function () {
      return limit.call(api()
        .find(query_for(opts))
        .sort(opts && opts.sort && query_sort(opts) || { startDate: -1 }), opts)
        .toArray();
    }, fn);
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
    return runWithCallback(function () {
      return api().find().sort({startDate: -1, _id: -1}).limit(1).toArray();
    }, fn);
  }

  function remove (_id, fn) {
    var objId = new ObjectID(_id);
    const promise = runWithCallback(function () {
      return api().deleteOne({ '_id': objId });
    }, fn);

    ctx.bus.emit('data-received');
    return promise;
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
