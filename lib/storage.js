'use strict';
var mongodb = require('mongodb');

function init (env, cb) {
  var MongoClient = mongodb.MongoClient;

  var my = { };
  function maybe_connect (cb) {
    if (my.db) {
      console.log("Reusing mongo connection");
      if (cb && cb.call) { cb(null, mongo); }
      return;
    }
    if (!env.mongo) {
      throw new Error("Mongo string is missing");
    }
    console.log("Connecting to mongo");
    MongoClient.connect(env.mongo, function connected (err, db) {
      if (err) {
        console.log("Error connecting to mongo, ERROR: %j", err);
        throw err;
      } else {
        console.log("Connected to mongo");
      }
      my.db = db;
      mongo.pool.db = my.db = db;

      if (cb && cb.call) { cb(err, mongo); }
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
