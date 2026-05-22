'use strict';

var find_options = require('./query');
var runWithCallback = require('../storage/run-with-callback');


function storage (env, ctx) {
   var ObjectID = require('mongodb').ObjectId;

  function normalizeObjectId(id) {
    try {
      return new ObjectID(id);
    } catch (err) {
      return new ObjectID();
    }
  }

  function create (docs, fn) {
    if (docs.length === 0) {
      return fn(null, []);
    }

    // Build bulkWrite operations for batch upsert
    var bulkOps = docs.map(function(doc) {
      if (!Object.prototype.hasOwnProperty.call(doc, 'created_at')) {
        doc.created_at = (new Date()).toISOString();
      }
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
        console.error('Problem upserting activity batch', err);
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


  function save (obj, fn) {
    obj._id = normalizeObjectId(obj._id);
    if (!Object.prototype.hasOwnProperty.call(obj, 'created_at')) {
      obj.created_at = (new Date( )).toISOString( );
    }
    return runWithCallback(async function () {
      await api().replaceOne({ _id: obj._id }, obj, { upsert: true });
      return obj;
    }, fn);
  }

  function query_for (opts) {
    return find_options(opts, storage.queryOpts);
  }

  function list(opts, fn) {
    // these functions, find, sort, and limit, are used to
    // dynamically configure the request, based on the options we've
    // been given

    // determine sort options
    function sort ( ) {
      return opts && opts.sort || {created_at: -1};
    }

    // configure the limit portion of the current query
    function limit ( ) {
      if (opts && opts.count) {
        return this.limit(parseInt(opts.count));
      }
      return this;
    }

    return runWithCallback(function () {
      return limit.call(api( )
        .find(query_for(opts))
        .sort(sort( ))
      ).toArray();
    }, fn);
  }
  
  function remove (_id, fn) {
    var objId = new ObjectID(_id);
    return runWithCallback(function () {
      return api().deleteOne({ '_id': objId });
    }, fn);
  }

  function api ( ) {
    return ctx.store.collection(env.activity_collection);
  }
  
  api.list = list;
  api.create = create;
  api.query_for = query_for;
  api.save = save;
  api.remove = remove;
  api.indexedFields = ['created_at'];
  return api;
}

storage.queryOpts = {
  dateField: 'created_at'
};

module.exports = storage;
