'use strict';

var find_options = require('./query');


function storage (env, ctx) {
   var ObjectID = require('mongodb-legacy').ObjectId;

  function create (docs, fn) {
    var firstErr = null
      , numDocs = docs.length
      , totalCreated = 0;

    docs.forEach(function(doc) {
      if (!Object.prototype.hasOwnProperty.call(doc, 'created_at')) {
        doc.created_at = (new Date( )).toISOString( );
      }
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
    obj._id = new ObjectID(obj._id);
    if (!Object.prototype.hasOwnProperty.call(obj, 'created_at')) {
      obj.created_at = (new Date( )).toISOString( );
    }
    api().insertOne(obj, function (err) {
      //id should be added for new docs
      fn(err, obj);
    });
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

    // handle all the results
    function toArray (err, entries) {
      fn(err, entries);
    }

    // now just stitch them all together
    limit.call(api( )
        .find(query_for(opts))
        .sort(sort( ))
    ).toArray(toArray);
  }
  
  function remove (_id, fn) {
    var objId = new ObjectID(_id);
    return api( ).deleteOne({ '_id': objId }, fn);
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

