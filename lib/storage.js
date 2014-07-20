'use strict';
var mongodb = require('mongodb');

function init (env) {
  var MongoClient = mongodb.MongoClient;

  var my = { };
  function maybe_connect (cb) {
    if (my.db) {
      console.log("Reusing mongo connection");
      if (cb && cb.call) { cb(null, mongo); }
      return;
    }
    console.log("Connecting to mongo");
    MongoClient.connect(env.mongo, function connected (err, db) {
      console.log("Connected to mongo, ERROR: %j", err);
      if (err) { throw err; }
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
  }

  mongo.collection = function get_collection (name) {
    return mongo.pool( ).db.collection(name);
  };

  mongo.with_collection = function with_collection (name) {
    return function use_collection (fn) {
      fn(null, mongo.pool( ).db.collection(name));
    };
  };

  return mongo( );
}

module.exports = init;
