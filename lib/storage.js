'use strict';
var mongodb = require('mongodb');

function init (env, cb) {
  var MongoClient = mongodb.MongoClient;

  var mongo = {
    collection: function get_collection (name) {
      return mongo.db.collection(name);
    },
    with_collection: function with_collection (name) {
      return function use_collection(fn) {
        fn(null, mongo.db.collection(name));
      }
    },
    limit: function limit (opts) {
      if (opts && opts.count) {
        return this.limit(parseInt(opts.count));
      }
      return this;
    },
    ensureIndexes: function(collection, fields) {
      fields.forEach(function (field) {
        console.info('Ensuring index for: ' + field);
        collection.ensureIndex(field, function (err) {
          if (err) {
            console.error('unable to ensureIndex for: ' + field + ' - ' + err);
          }
        });
      })
    },
    db: null // Yet to be assigned
  };

  function newConnection (cb) {
    if (!env.mongo) {
      throw new Error('MongoDB connection string is missing');
    }

    console.log('Setting up new connection to MongoDB');
    MongoClient.connect(env.mongo, function connected (err, db) {
      if (err) {
        console.log('Error connecting to MongoDB, ERROR: %j', err);
        throw err;
      } else {
        console.log('Successfully established a connected to MongoDB');
      }

      mongo.db = db;

      // If there is a valid callback, then invoke the function to perform the callback
      if (cb && cb.call)
          cb(err, mongo);
    });
  }

  return function mongo (cb) {
    if (mongo.db != null) {
      console.log('Reusing MongoDB connection handler');
      // If there is a valid callback, then return the Mongo-object
      if (cb && cb.call) {
        cb(null, mongo);
      }
    } else {
      newConnection(cb);
    }

    return mongo;
  }
}

module.exports = init;
