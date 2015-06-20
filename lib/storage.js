'use strict';

var mongodb = require('mongodb');
var override = require('json-override');

/**
 *
 * @param env Environment variables
 * @param cb Callback function
 * @param options Possible to alter the options of the database abstraction
 * @returns MongoDB Connection
 */
function init(env, cb, options) {
    // Make it optional, for backwards compatibility.
    if (typeof options == "undefined")
        options = {};

    var opts = override({
        connectionUrl: env.mongo,
        connectionRetries: 5, // number of retries.
        connectionTimeout: 5000 // in milliseconds
    }, options);
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

        if (!opts.connectionUrl)
            throw new Error('MongoDB connection string is missing');

        var connectWithRetry = function(opts) {
            return MongoClient.connect(opts.connectionUrl, function connected(err, db) {
                if (err && --opts.connectionRetries >= 0) {
                    console.error('Failed to connect to MongoDB,', opts.connectionRetries ,'retries left, next attempt in', opts.connectionTimeout, 'ms');
                    setTimeout(connectWithRetry, opts.connectionTimeout, opts);
                }
                else {
                    console.log('Connected to MongoDB');

                    // Save the connection handler to a local variable.
                    mongo.db = db;

                    if (cb && cb.call)
                        cb(err, mongo);
                }

            });
        };
        connectWithRetry(opts);
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
            console.info('Ensuring index for:', field);
            collection.ensureIndex(field, function (err) {
                if (err)
                    console.error('Unable to ensureIndex for:', field, '-', err);
            });
        });
    };

    mongo.db = null;
    return mongo(cb);
}

module.exports = init;
