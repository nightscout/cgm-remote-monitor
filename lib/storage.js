'use strict';

var mongodb = require('mongodb');

/**
 *
 * @param env Environment variables
 * @param cb Callback function
 * @returns MongoDB Connection
 */
function init(env, cb) {
    var MongoClient = mongodb.MongoClient;

    /**
     * Connects to the MongoDB database, or uses a connection which is still open.
     * @param cb Callback-function which will be executed against the DB
     */
    function maybe_connect(cb) {
        if (mongo.db) {
            console.log('Reusing mongo connection');
            if (cb && cb.call)
                cb(null, mongo);
            return;
        }

        if (!env.mongo)
            throw new Error('MongoDB connection string is missing');

        var connectWithRetry = function() {
            return MongoClient.connect(env.mongo, function connected(err, db) {
                if (err) {
                    console.error('Failed to connect to MongoDB, retrying in 5 sec', err);
                    setTimeout(connectWithRetry, 5000);
                }
                else {
                    Console.log('Connected to MongoDB');

                    // Save the connection
                    mongo.db = db;

                    if (cb && cb.call)
                        cb(err, mongo);
                }

            });
        };
        connectWithRetry();
    };

    function mongo(cb) {
        maybe_connect(cb);
        return mongo;
    };

    mongo.collection = function get_collection(name) {
        return mongo.db.collection(name);
    };

    mongo.with_collection = function with_collection(name) {
        return function use_collection(fn) {
            fn(null, mongo.db.collection(name));
        };
    };

    mongo.limit = function limit(opts) {
        if (opts && opts.count) {
            return this.limit(parseInt(opts.count));
        }
        return this;
    };

    mongo.ensureIndexes = function (collection, fields) {
        fields.forEach(function (field) {
            console.info('Ensuring index for: ' + field);
            collection.ensureIndex(field, function (err) {
                if (err)
                    console.error('Unable to ensureIndex for: ' + field + ' - ' + err);
            });
        });
    };

    mongo.db = null;
    return mongo(cb);
}

module.exports = init;
