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
        /*
        TODO: There is still a bug in this section of the code.
        As long as the mongo.db variable isn't set, the MongoClient.connect is called until
        the callback is executed, but this might take a while.. This is illustrated by having
        two or three times 'Connecting to mongo' in the log of the build.
         */
        if (mongo.db) {
            console.log("Reusing mongo connection");
            if (cb && cb.call)
                cb(null, mongo);
            return;
        }

        if (!env.mongo)
            throw new Error("Mongo string is missing");

        console.log("Connecting to mongo");
        MongoClient.connect(env.mongo, function connected(err, db) {
            if (err) {
                console.log("Error connecting to mongo, ERROR: %j", err);
                throw err;
            }

            console.log("Connected to mongo");

            // Save the connection
            mongo.db = db;

            if (cb && cb.call)
                cb(err, mongo);
        });
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
            console.info("Ensuring index for: " + field);
            collection.ensureIndex(field, function (err) {
                if (err)
                    console.error("unable to ensureIndex for: " + field + " - " + err);
            });
        });
    };

    mongo.db = maybe_connect(cb);
    return mongo(cb);
}

module.exports = init;
