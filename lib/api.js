'use strict';

var ENTRIES_DEFAULT_COUNT = 10;

var with_collection = null;

module.exports = function (coll_fn) {
    with_collection = coll_fn;

    var express = require('express'),
        api = express(),
        bodyParser = require('body-parser');

    api.use(bodyParser());

    api.get('/settings', function (req, res) {
        return res.json({
            'units': 'mg/dl',
            'theme': 'battleship'
        });
    });

    api.get('/entries', function(req, res) {
        var count = ENTRIES_DEFAULT_COUNT;
        getEntries(function(entries) {
            return res.json(entries);
        }, count);
    });

    api.get('/entries/current', function(req, res) {
        getEntries(function(entries) {
            return res.json(entries);
        }, 1);
    });

    return api;
};

////////////////////////////////////////////////////////////////////////////////////////////////////
// Define functions to CRUD data for the API
////////////////////////////////////////////////////////////////////////////////////////////////////

function getEntries(fn, count) {
    with_collection(function(err, collection) {
        collection.find({ }).sort({"date": -1}).limit(count).toArray(function (err, entries) {
            console.log('got raw entries', entries.length);
            fn(entries);
        });
    });
}

