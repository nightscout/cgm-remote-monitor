'use strict';

var es = require('event-stream');
var sgvdata = require('sgvdata');

/**********\
 * Entries
 * Encapsulate persistent storage of sgv entries.
\**********/

function entries (name, storage) {

  // TODO: Code is a little redundant.

  var with_collection = storage.with_collection(name);

  // query for entries from storage
  function list (opts, fn) {
    with_collection(function (err, collection) {
      // these functions, find, sort, and limit, are used to
      // dynamically configure the request, based on the options we've
      // been give

      // determine find options
      function find ( ) {
        var q = opts && opts.find ? opts.find : { };
        return q;
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
        .sort(sort( )))
        // .limit(limit( ))
        .toArray(toArray)
      ;
      // limit.call(sort.call(find.call(collection))).toArray(toArray);

    });
  }

  // return writable stream to lint each sgv record passing through it
  function map ( ) {
    return sgvdata.lint( );
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
      return;
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
            totalCreated = 0;

        docs.forEach(function(doc) {
            collection.update(doc, doc, {upsert: true}, function (err, created) {
                firstErr = firstErr || err;
                totalCreated += created;
            });
        });
        fn(firstErr, totalCreated, docs);
      });
  }

  function getEntry(fn, id) {
      console.info("trying to find entry for id: " + id);
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

  function getEntries(fn, count) {
      with_collection(function(err, collection) {
          if (err)
              fn(err);
          else
              collection.find({ }).sort({"date": -1}).limit(count).toArray(function (err, entries) {
                  if (err)
                      fn(err);
                  else
                      fn(null, entries);
              });
      });
  }

  // closure to represent the API
  function api ( ) {
    // obtain handle usable for querying the collection associated
    // with these records
    return storage.pool.db.collection(name);
  }

  // Expose all the useful functions
  api.list = list;
  api.echo = sgvdata.sync.json.echo;
  api.map = map;
  api.create = create;
  api.persist = persist;
  api.getEntries = getEntries;
  api.getEntry = getEntry;
  return api;
}

// expose module
module.exports = entries;

