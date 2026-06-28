'use strict';

var find_options = require('./query');
var consts = require('../constants');
var runWithCallback = require('../storage/run-with-callback');

function storage (collection, ctx) {
   var ObjectID = require('mongodb').ObjectId;
   var profileSort = { startDate: -1, _id: -1 };

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
      return api().find({ }).limit(limit).sort(profileSort).toArray();
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
        .sort(opts && opts.sort && query_sort(opts) || profileSort), opts)
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
      return api().find().sort(profileSort).limit(1).toArray();
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

  function prune (keepCount, fn) {
    return runWithCallback(async function () {
      var oldProfileBoundary = await api()
        .find({}, { projection: { _id: 1, startDate: 1 } })
        .sort(profileSort)
        .skip(keepCount)
        .limit(1)
        .toArray();

      if (oldProfileBoundary.length === 0) {
        return { deletedCount: 0 };
      }

      var pruneFilter = pruneFilterForBoundary(oldProfileBoundary[0]);

      var stat = await api().deleteMany(pruneFilter);
      ctx.bus.emit('data-update', {
        type: 'profile'
        , op: 'remove'
        , count: stat.deletedCount
        , changes: pruneFilter
      });
      ctx.bus.emit('data-received');

      return stat;
    }, fn);
  }

  function pruneFilterForBoundary (boundary) {
    if (Object.prototype.hasOwnProperty.call(boundary, 'startDate') && boundary.startDate !== null) {
      return {
        $or: [
          { startDate: { $lt: boundary.startDate } }
          , { startDate: boundary.startDate, _id: { $lte: boundary._id } }
          , { startDate: null }
        ]
      };
    }

    return {
      startDate: null
      , _id: { $lte: boundary._id }
    };
  }

  function api () {
    return ctx.store.collection(collection);
  }
  
  api.list = list;
  api.list_query = list_query;
  api.create = create;
  api.save = save;
  api.remove = remove;
  api.prune = prune;
  api.last = last;
  api.indexedFields = [
    'startDate'
    , 'created_at'
    , 'NSCLIENT_ID'
    , { startDate: -1, _id: -1 }
  ];
  return api;
}

module.exports = storage;
