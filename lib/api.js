'use strict';

var HTTP_OK = 200,
    HTTP_UNAUTHORIZED = 401,
    HTTP_VALIDATION_ERROR = 422, // Unprocessable Entity - Used for validation errors
    HTTP_INTERNAL_ERROR = 500;
var ENTRIES_DEFAULT_COUNT = 10;

var ObjectID = require('mongodb').ObjectID;

var with_entries_collection = null,
    with_settings_collection = null;

module.exports = function (env, entry_coll_fn, settings_coll_fn) {
    with_entries_collection = entry_coll_fn;
    with_settings_collection = settings_coll_fn;

    var express = require('express'),
        api = express(),
        bodyParser = require('body-parser');

    api.set('title', 'Nightscout API v1');
    api.use(bodyParser.json());
    api.use(bodyParser.urlencoded({
        extended: true
    }));
    
    api.get('/authorized/:secret/test', verifyAuthorization, function (req, res, next) {
        return res.json({status: 'ok'});
    });

    api.get('/authorized/test', verifyAuthorization, function (req, res, next) {
        return res.json({status: 'ok'});
    });

    api.get('/entries', function(req, res) {
        // If "?count=" is present, use that number to decided how many to return.
        var count = parseInt(req.query.count, 0) || ENTRIES_DEFAULT_COUNT;
        getEntries(function(err, entries) {
            if (err)
                sendJSONStatus(res, HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else
                return res.json(entries);
        }, count);
    });

    api.get('/entries/current', function(req, res) {
        getEntries(function(err, entries) {
            if (err)
                sendJSONStatus(res, HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else
                return res.json(entries);
        }, 1);
    });

    api.get('/entries/:id', function(req, res) {
        getEntry(function(err, entry) {
            if (err)
                sendJSONStatus(res, HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else
                return res.json(entry);
        }, req.params.id);
    });

    api.get('/settings', function(req, res) {
        getSettings(function(err, settings) {
            if (err)
                sendJSONStatus(res, HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else
                return res.json(settings);
        });
    });

    api.put('/settings', verifyAuthorization, function(req, res) {
        // Retrieve the JSON formatted record.
        var json = req.body;
        //console.log(json);
        
        // Send the new settings to mongodb.
        updateSettings(function(err, settings) {
            if (err)
                sendJSONStatus(res, HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else
                return sendJSONStatus(res, HTTP_OK, 'Settings update successful', settings);
        }, json);
    });

    function verifyAuthorization(req, res, next) {
        console.log('verifyAuthorization');
        // Retrieve the secret values to be compared.
        var api_secret = env.api_secret;
        var secret = req.params.secret ? req.params.secret : req.header('API_SECRET');

        // Return an error message if the authorization fails.
        var unauthorized = (typeof api_secret === 'undefined' || secret != api_secret);
        if (unauthorized) {
            sendJSONStatus(res, HTTP_UNAUTHORIZED, 'Unauthorized', 'API_SECRET Request Header is incorect or missing.');
        } else {
            next();
        }

        return unauthorized;
    }
    
    return api;
};

////////////////////////////////////////////////////////////////////////////////////////////////////
// Define functions to CRUD data for the API
////////////////////////////////////////////////////////////////////////////////////////////////////

function cleanSingleRecord(val) {
    // Remove the [] array brackets from single record collections (e.g. settings).
    val = JSON.stringify(val);
    val = val.substring(1, val.length-1);
    return JSON.parse(val.trim());
}

function getEntry(fn, id) {
    console.info("trying to find entry for id: " + id);
    with_entries_collection(function(err, collection) {
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
    with_entries_collection(function(err, collection) {
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

function getSettings(fn) {
    with_settings_collection(function(err, collection) {
        if (err)
            fn(err);
        else
            // Retrieve the existing settings record.
            collection.find().toArray(function(err, settings) {
                if (err)
                    fn(err);
                else
                    // Strip the record of the enclosing square brackets.
                    settings = cleanSingleRecord(settings);
                    fn(null, settings);
            });
    });
}

function updateSettings(fn, json) {
    with_settings_collection(function(err, collection) {
        if (err)
            fn(err);
        else
            // Retrieve the existing settings record.
            collection.find().toArray(function(err, settings) {
                if (err)
                    fn(err);
                else {
                    // Strip the record of the enclosing square brackets.
                    settings = cleanSingleRecord(settings);
                    //console.log(settings._id);
                    
                    // Send the updated record to mongodb.
                    collection.update(
                        { '_id' : new ObjectID(settings._id) },
                        { $set: json },
                        function (err, result) {
                            if (err) return err;
                            return result;
                        }
                    );
                    
                    // Return to the calling function to display our success.
                    fn(null, json);
                }
            });
    });
}

// Craft a JSON friendly status (or error) message.
function sendJSONStatus(res, status, title, description) {
    res.status(status).json({
        status: status,
        message: title,
        description: description
    });
}
