'use strict';

var es = require('event-stream');
var sgvdata = require('sgvdata');
var ObjectID = require('mongodb').ObjectID;

// declare local constants for time differences
var TIME_10_MINS = 10 * 60 * 1000,
  TIME_15_MINS = 15 * 60 * 1000,
  TIME_30_MINS = TIME_15_MINS * 2;


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

function storage(name, storage, pushover, env) {

  // TODO: Code is a little redundant.

  var with_collection = storage.with_collection(name);

  // query for entries from storage
  function list (opts, fn) {
    with_collection(function (err, collection) {
      // these functions, find, sort, and limit, are used to
      // dynamically configure the request, based on the options we've
      // been given

      // determine find options
      function find ( ) {
        var finder = find_sgv_query(opts);
        var q = finder && finder.find ? finder.find : { };
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
            fn(firstErr, docs);
          }
        });
        sendPushover(doc);
      });
    });
  }

  function sendPushover(doc) {
    if (doc.type && doc.date && pushover) {
      if (doc.type == 'mbg') {
        sendMBGPushover(doc);
      } else if (doc.type == 'sgv') {
        sendSGVPushover(doc);
      }
    }
  }

  //currently the Android upload will send the last MBG over and over, make sure we get a single notification
  var lastMBGDate = 0;

  function sendMBGPushover(doc) {

    if (doc.mbg && doc.type == 'mbg' && doc.date != lastMBGDate) {
      var offset = new Date().getTime() - doc.date;
      if (offset > TIME_10_MINS) {
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
      lastMBGDate = doc.date;
    }
  }

  // global variable for last alert time
  var lastAlert = 0;
  var lastSGVDate = 0;

  function sendSGVPushover(doc) {

    if (!doc.sgv || doc.type != 'sgv') {
      return;
    }

    var now = new Date().getTime(),
      offset = new Date().getTime() - doc.date;

    if (offset > TIME_10_MINS || doc.date == lastSGVDate) {
      console.info('No SVG Pushover, offset: ' + offset + ' too big, doc.date: ' + doc.date + ', now: ' + new Date().getTime() + ', lastSGVDate: ' + lastSGVDate);
      return;
    }

    // initialize message data
    var sinceLastAlert = now - lastAlert,
      title = 'CGM Alert',
      priority = 0,
      sound = null,
      readingtime = doc.date,
      readago = now - readingtime;

    console.info('now: ' + now);
    console.info('doc.sgv: ' + doc.sgv);
    console.info('doc.direction: ' + doc.direction);
    console.info('doc.date: ' + doc.date);
    console.info('readingtime: ' + readingtime);
    console.info('readago: ' + readago);

    // set vibration pattern; alert value; 0 nothing, 1 normal, 2 low, 3 high
    if (doc.sgv < 39) {
      if (sinceLastAlert > TIME_30_MINS) {
        title = 'CGM Error';
        priority = 1;
        sound = 'persistent';
      }
    } else if (doc.sgv < env.thresholds.bg_low && sinceLastAlert > TIME_15_MINS) {
      title = 'Urgent Low';
      priority = 2;
      sound = 'persistent';
    } else if (doc.sgv < env.thresholds.bg_target_bottom && sinceLastAlert > TIME_15_MINS) {
      title = 'Low';
      priority = 1;
      sound = 'falling';
    } else if (doc.sgv < 120 && doc.direction == 'DoubleDown') {
      title = 'Double Down';
      priority = 1;
      sound = 'falling';
    } else if (doc.sgv == 100 && doc.direction == 'Flat' && sinceLastAlert > TIME_15_MINS) { //Perfect Score - a good time to take a picture :)
      title = 'Perfect';
      priority = 0;
      sound = 'cashregister';
    } else if (doc.sgv > 120 && doc.direction == 'DoubleUp' && sinceLastAlert > TIME_15_MINS) {
      title = 'Double Up';
      priority = 1;
      sound = 'climb';
    } else if (doc.sgv > env.thresholds.bg_target_top && sinceLastAlert > TIME_30_MINS) {
      title = 'High';
      priority = 1;
      sound = 'climb';
    } else if (doc.sgv > env.thresholds.bg_high && sinceLastAlert > TIME_30_MINS) {
      title = 'Urgent High';
      priority = 1;
      sound = 'persistent';
    }

    if (sound != null) {
      lastAlert = now;

      var msg = {
        expire: 14400, // 4 hours
        message: 'BG NOW: ' + doc.sgv,
        title: title,
        sound: sound,
        timestamp: new Date(doc.date),
        priority: priority,
        retry: 30
      };

      pushover.send(msg, function (err, result) {
        console.log(result);
      });
    }


    lastSGVDate = doc.date;
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
    return storage.pool.db.collection(name);
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

