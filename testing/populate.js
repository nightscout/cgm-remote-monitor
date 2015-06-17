'use strict';
///////////////////////////////////////////////////
// This script is intended to be run as a cron job
// every n-minutes or whatever the equiv is on windows
//
// Author: John A. [euclidjda](https://github.com/euclidjda)
// Source: https://gist.github.com/euclidjda/4ae207a89921f21382a9
///////////////////////////////////////////////////

///////////////////////////////////////////////////
// DB Connection setup and utils
///////////////////////////////////////////////////

var mongodb = require('mongodb');
var software = require('./../package.json');
var env = require('./../env')();

var util = require('./helpers/util');

main();

function main() {
    var MongoClient = mongodb.MongoClient;
    MongoClient.connect(env.mongo, function connected(err, db) {

        console.log("Connecting to mongo...");
        if (err) {
            console.log("Error occurred: ", err);
            throw err;
        }
        populate_collection(db);
    });
}

function populate_collection(db) {
    var cgm_collection = db.collection(env.mongo_collection);
    var new_cgm_record = util.get_cgm_record();

    cgm_collection.insert(new_cgm_record, function (err, created) {
        if (err) {
            throw err;
        }
        process.exit(0);
    });
}
