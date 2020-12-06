'use strict';

var find_options = require('./query');

function storage (collection, ctx) {
  var ObjectID = require('mongodb').ObjectID;

  function create(obj, fn) {
    if (! obj.hasOwnProperty('created_at')){
      obj.created_at = (new Date()).toISOString();
    }
    api().insert(obj, function (err, doc) {
      fn(null, doc.ops);
    });
  }

  function last(fn) {
    return list({count: 1}, function (err, entries) {
      if (entries && entries.length > 0) {
        fn(err, entries[0]);
      } else {
        fn(err, null);
      }
    });
  }

  var with_collection = ctx.store.with_collection(collection);

  function query_for (opts) {
    return find_options(opts, storage.queryOpts);
  }

  function list(opts, fn) {
    with_collection(function (err, collection) {
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
      limit.call(collection
          .find(query_for(opts))
          .sort(sort( ))
      ).toArray(toArray);
    });
  }

  function remove (_id, fn) {
    var filter;
    if (_id === '*') {
      filter = {};
    } else {
      filter = { '_id': new ObjectID(_id) };
    }
    return api( ).remove(filter, fn);
  }

  function api() {
    return ctx.store.db.collection(collection);
  }

  api.list = list;
  api.create = create;
  api.last = last;
  api.remove = remove;
  api.indexedFields = ['created_at'];
  return api;
}

storage.queryOpts = {
  dateField: 'created_at'
};

module.exports = storage;
