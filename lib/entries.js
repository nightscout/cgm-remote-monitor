'use strict';

var es = require('event-stream');
var sgvdata = require('sgvdata');

var TEN_MINS = 10 * 60 * 1000;

/**********\
 * Entries
 * Encapsulate persistent storage of sgv entries.
\**********/

function storage(name, storage, pushover) {

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
            totalCreated = 0;

        docs.forEach(function(doc) {
            collection.update(doc, doc, {upsert: true}, function (err, created) {
                firstErr = firstErr || err;
                totalCreated += created;
            });
            sendPushover(doc);
        });
        fn(firstErr, totalCreated, docs);
      });
  }

  //currently the Android upload will send the last MBG over and over, make sure we get a single notification
  var lastMBG = 0;

  function sendPushover(doc) {
      if (doc.type && doc.mbg && doc.type == 'mbg' && doc.date && doc.date != lastMBG && pushover) {
          var offset = new Date().getTime() - doc.date;
          if (offset > TEN_MINS) {
              console.info('No MBG Pushover, offset: ' + offset + ' too big, doc.date: ' + doc.date + ', now: ' + new Date().getTime());
          } else {
              var msg = {
                  expire: 14400, // 4 hours
                  message: '\nMeter BG: ' + doc.mbg,
                  title: 'Calibration',
                  sound: 'magic',
                  timestamp: new Date(doc.date),
                  priority: 0,
                  retry: 30
              };

              pushover.send(msg, function (err, result) {
                  console.log(result);
              });
          }
          lastMBG = doc.date;
      }
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

function ensureIndexes(name, storage) {
  storage.with_collection(name)(function(err, collection) {
    if (err) {
      console.error("ensureIndexes, unable to get collection for: " + name + " - " + err);
    } else {
      storage.ensureIndexes(collection, ['date', 'type', 'sgv']);
    }
  });
}

// expose module
module.exports = {
  storage: storage,
  ensureIndexes: ensureIndexes
};

