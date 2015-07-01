'use strict';

var es = require('event-stream');
var sgvdata = require('sgvdata');
var units = require('./units')();
var ObjectID = require('mongodb').ObjectID;

/**********\
 * Entries
 * Encapsulate persistent storage of sgv entries.
\**********/

function find_sgv_query (opts) {
  if (opts && opts.find && opts.find.sgv) {
    Object.keys(opts.find.sgv).forEach(function (key) {
      var is_keyword = /^\$/g;
      if (is_keyword.test(key)) {
        opts.find.sgv[key] = parseInt(opts.find.sgv[key]);
      }
    });
  }
  return opts;
}

function storage(env, ctx) {

  // TODO: Code is a little redundant.

  var with_collection = ctx.store.with_collection(env.mongo_collection);

  // query for entries from storage
  function list (opts, fn) {
    with_collection(function (err, collection) {
      // these functions, find, sort, and limit, are used to
      // dynamically configure the request, based on the options we've
      // been given

      // determine find options
      function find ( ) {
        var finder = find_sgv_query(opts);
        return finder && finder.find ? finder.find : { };
        // return this.find(q);
      }

      // determine sort options
      function sort ( ) {
        return {"date": -1};
        // return this.sort({"date": -1});
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
          .find(find( ))
          .sort(sort( ))
      ).toArray(toArray);
    });
  }

  // return writable stream to lint each sgv record passing through it
  function map ( ) {
    function iter (item, next) {
      if (item && item.type) {
        return next(null, item);
      }
      return next(null, sgvdata.sync.json.echo(item));
    }
    return es.map(iter);
  }

  // writable stream that persists all records
  // takes function to call when done
  function persist (fn) {
    // receives entire list at end of stream
    function done (err, result) {
      // report any errors
      if (err) return fn(err, result);
      // batch insert a list of records
      create(result, fn);
    }
    // lint and store the entire list
    return es.pipeline(map( ), es.writeArray(done));
  }

  function update (fn) {
    // TODO: implement
  }

  function remove (fn) {
    // TODO: implement
  }

  // store new documents using the storage mechanism
  function create (docs, fn) {
    with_collection(function(err, collection) {
      if (err) { fn(err); return; }
      // potentially a batch insert
      var firstErr = null,
          numDocs = docs.length,
          totalCreated = 0;

      docs.forEach(function(doc) {
        var query  = (doc.sysTime && doc.type) ? {sysTime: doc.sysTime, type: doc.type} : doc;
        collection.update(query, doc, {upsert: true}, function (err, created) {
          firstErr = firstErr || err;
          if (++totalCreated === numDocs) {
            //TODO: this is triggering a read from Mongo, we can do better
            ctx.bus.emit('data-received');
            fn(firstErr, docs);
          }
        });
      });
    });
  }

  function getEntry(id, fn) {
    with_collection(function(err, collection) {
      if (err)
        fn(err);
      else
        collection.findOne({"_id": ObjectID(id)}, function (err, entry) {
          if (err)
            fn(err);
          else
            fn(null, entry);
        });
    });
  }

  // closure to represent the API
  function api ( ) {
    // obtain handle usable for querying the collection associated
    // with these records
    return ctx.store.db.collection(env.mongo_collection);
  }

  // Expose all the useful functions
  api.list = list;
  api.echo = sgvdata.sync.json.echo;
  api.map = map;
  api.create = create;
  api.persist = persist;
  api.getEntry = getEntry;
  api.indexedFields = indexedFields;
  return api;
}

var indexedFields = [ 'date', 'type', 'sgv', 'sysTime' ];
storage.indexedFields = indexedFields;

// expose module
storage.storage = storage;
module.exports = storage;

