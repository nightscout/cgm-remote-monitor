'use strict';
var mongodb = require('mongodb');

function init (env, cb) {
  var MongoClient = mongodb.MongoClient;

  var my = { };
  function maybe_connect (cb) {

    if (my.db) {
      console.log("Reusing MongoDB connection handler");
      // If there is a valid callback, then return the Mongo-object
      if (cb && cb.call) { cb(null, mongo); }
      return;
    }

    if (!env.mongo) {
      throw new Error("MongoDB connection string is missing");
    }

    console.log("Setting up new connection to MongoDB");
    MongoClient.connect(env.mongo, function connected (err, db) {
      if (err) {
        console.log("Error connecting to MongoDB, ERROR: %j", err);
        throw err;
      } else {
        console.log("Successfully established a connected to MongoDB");
      }

      // FIXME Fokko: I would suggest to just create a private db variable instead of the separate my, pool construction.
      my.db = db;
      mongo.pool.db = my.db = db;

      // If there is a valid callback, then invoke the function to perform the callback
      if (cb && cb.call)
          cb(err, mongo);
    });
  }

  function mongo (cb) {
    maybe_connect(cb);
    mongo.pool.db = my.db;
    return mongo;
  }

  mongo.pool = function ( ) {
    return my;
  };

  mongo.collection = function get_collection (name) {
    return mongo.pool( ).db.collection(name);
  };

  mongo.with_collection = function with_collection (name) {
    return function use_collection (fn) {
      fn(null, mongo.pool( ).db.collection(name));
    };
  };

  mongo.limit = function limit (opts) {
    if (opts && opts.count) {
      return this.limit(parseInt(opts.count));
    }
    return this;
  };

  mongo.ensureIndexes = function(collection, fields) {
    fields.forEach(function (field) {
      console.info("ensuring index for: " + field);
      collection.ensureIndex(field, function (err) {
        if (err) {
          console.error("unable to ensureIndex for: " + field + " - " + err);
        }
      });
    });
  };

  return mongo(cb);
}

module.exports = init;
