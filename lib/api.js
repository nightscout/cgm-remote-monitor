'use strict';

var HTTP_OK = 200,
    HTTP_UNAUTHORIZED = 401,
    HTTP_VALIDATION_ERROR = 422, // Unprocessable Entity - Used for validation errors
    HTTP_INTERNAL_ERROR = 500;
var ENTRIES_DEFAULT_COUNT = 10;

var ObjectID = require('mongodb').ObjectID;

var with_collection = null;

module.exports = function (coll_fn) {
    with_collection = coll_fn;

    var express = require('express'),
        api = express(),
        bodyParser = require('body-parser');

    api.use(bodyParser());

    api.get('/settings', function(req, res) {
        return res.json({
            'units': 'mg/dl',
            'theme': 'battleship'
        });
    });
    api.put('/settings', function(req, res) {
        if (verifyAuthorization(req, res)) {
            return res.json({"TODO": "Create updateSettings() function"});
        }
    });

    api.get('/entries', function(req, res) {
        var count = parseInt(req.query.count, 0) || ENTRIES_DEFAULT_COUNT;
        getEntries(function(err, entries) {
            if (err)
                sendJSONError(res, HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else
                return res.json(entries);
        }, count);
    });

    api.get('/entries/current', function(req, res) {
        getEntries(function(err, entries) {
            if (err)
                sendJSONError(res, HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else
                return res.json(entries);
        }, 1);
    });

    api.get('/entries/:id', function(req, res) {
        getEntry(function(err, entry) {
            if (err)
                sendJSONError(res, HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else
                return res.json(entry);
        }, req.params.id);
    });

    return api;
};

////////////////////////////////////////////////////////////////////////////////////////////////////
// Define functions to CRUD data for the API
////////////////////////////////////////////////////////////////////////////////////////////////////

function getEntry(fn, id) {
    console.info("trying to find entry for id: " + id);
    with_collection(function(err, collection) {
        if (err)
            fn(err);
        else
            collection.findOne({"_id": ObjectID(id)}, function (err, entry) {
                if (err)
                    fn(err);
                else
                    fn(null, entry);
            });
    });
}

function getEntries(fn, count) {
    with_collection(function(err, collection) {
        if (err)
            fn(err);
        else
            collection.find({ }).sort({"date": -1}).limit(count).toArray(function (err, entries) {
                if (err)
                    fn(err);
                else
                    fn(null, entries);
            });
    });
}

function verifyAuthorization(req, res) {
    var authorized = true;
    
    // Retrieve the secret values to be compared.
    var api_secret = process.env.API_SECRET;
    var secret = req.header("API_SECRET");
    
    console.log({"secret": secret, "API_SECRET": api_secret});
    
    // Return an error message if the authorization fails.
    if (typeof api_secret === "undefined" || secret != api_secret) {
        sendJSONError(res, HTTP_UNAUTHORIZED, 'Unauthorized', 'API_SECRET Request Header is missing or incorrect.');
        
        authorized = false;
    }
    
    return authorized;
}

// Craft a JSON friendly error message.
function sendJSONError(res, status, title, description) {
    res.status(status).json({
        "status" : status,
        "message" : title,
        "description" : description
    });
}