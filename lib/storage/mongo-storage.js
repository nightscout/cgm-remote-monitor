'use strict';

var mongodb = require('mongodb');

var connection = null;

function init (env, cb, forceNewConnection) {
  var MongoClient = mongodb.MongoClient;
  var mongo = {};

  function maybe_connect (cb) {

    if (connection != null && !forceNewConnection) {
      console.log('Reusing MongoDB connection handler');
      // If there is a valid callback, then return the Mongo-object
      mongo.db = connection;

      if (cb && cb.call) {
        cb(null, mongo);
      }
    } else {
      if (!env.storageURI) {
        throw new Error('MongoDB connection string is missing. Please set MONGO_CONNECTION environment variable');
      }

      console.log('Setting up new connection to MongoDB');
      var timeout =  30 * 1000;
      var options = { reconnectInterval: 10000, reconnectTries: 500, connectTimeoutMS: timeout,
                      socketTimeoutMS: timeout, useNewUrlParser: true };

      var connect_with_retry = function(i) {
        return MongoClient.connect(env.storageURI, options, function connected(err, client) {
          if (err) {
            //console.log('err=', err)
            if (err.name && err.name === "MongoNetworkError") {
                var timeout = (i > 15) ? 60000 : i*3000;
                console.log('Error connecting to MongoDB: %j - retrying in ' + timeout/1000 + ' sec', err);
                setTimeout(connect_with_retry, timeout, i+1);
            } else if (err.message) {
                throw new Error('MongoDB connection string '+env.storageURI+' seems invalid: '+err.message) ; 
            }
          } else {
            console.log('Successfully established a connected to MongoDB');
            
            var dbName = env.storageURI.split('/').pop().split('?');
            dbName=dbName[0]; // drop Connection Options
            mongo.db = client.db(dbName);
            connection = mongo.db;
            mongo.client = client;
            // If there is a valid callback, then invoke the function to perform the callback

            if (cb && cb.call) {
              cb(err, mongo);
            }
          }
        });
      };
      connect_with_retry(1);
    }
  }

  mongo.collection = function get_collection (name) {
    return connection.collection(name);
  };

  mongo.ensureIndexes = function ensureIndexes (collection, fields) {
    fields.forEach(function (field) {
      console.info('ensuring index for: ' + field);
      collection.ensureIndex(field, function (err) {
        if (err) {
          console.error('unable to ensureIndex for: ' + field + ' - ' + err);
        }
      });
    });
  };

  return maybe_connect(cb);
}

module.exports = init;
