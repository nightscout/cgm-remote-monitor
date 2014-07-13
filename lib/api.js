'use strict';

var HTTP_OK = 200,
    HTTP_UNAUTHORIZED = 401,
    HTTP_VALIDATION_ERROR = 422, // Unprocessable Entity - Used for validation errors
    HTTP_INTERNAL_ERROR = 500;
var ENTRIES_DEFAULT_COUNT = 10;

var ObjectID = require('mongodb').ObjectID;

function api (env, store, entries, settings) {

    var express = require('express'),
        api = express(),
        bodyParser = require('body-parser');

    var verifyAuthorization = require('./middleware/verify-token')(env);
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
        console.log('body', req.body);
        console.log('params', req.params);
        console.log('query', req.query);
        // If "?count=" is present, use that number to decided how many to return.
        var count = parseInt(req.query.count, 0) || ENTRIES_DEFAULT_COUNT;
        entries.getEntries(function(err, entries) {
            if (err)
                sendJSONStatus(res, HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else
                return res.json(entries);
        }, count);
    });

    api.get('/entries/current', function(req, res) {
        entries.getEntries(function(err, entries) {
            if (err)
                sendJSONStatus(res, HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else
                return res.json(entries);
        }, 1);
    });

    api.get('/entries/:id', function(req, res) {
        console.log('body', req.body);
        console.log('params', req.params);
        console.log('query', req.query);
        entries.getEntry(function(err, entry) {
            if (err)
                sendJSONStatus(res, HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else
                return res.json(entry);
        }, req.params.id);
    });

    api.get('/settings', function(req, res) {
        console.log('body', req.body);
        console.log('params', req.params);
        console.log('query', req.query);
        settings.getSettings(function(err, settings) {
            if (err)
                sendJSONStatus(res, HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else
                return res.json(settings);
        });
    });

    api.put('/settings', verifyAuthorization, function(req, res) {
        // Retrieve the JSON formatted record.
        var json = req.body;
        console.log(req.body);
        
        // Send the new settings to mongodb.
        updateSettings(function(err, settings) {
            if (err)
                sendJSONStatus(res, HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else {
                // Add a warning to the outgoing status when HTTPS is not being used.
                var warning = '';
                if (req.secure === false)
                    warning = 'WARNING: HTTPS is required to secure your data!';
                
                return sendJSONStatus(res, HTTP_OK, 'Settings update successful', settings, warning);
            }
        }, json);
    });

    return api;
}
module.exports = api;


////////////////////////////////////////////////////////////////////////////////////////////////////
// Define functions to CRUD data for the API
////////////////////////////////////////////////////////////////////////////////////////////////////

// Craft a JSON friendly status (or error) message.
function sendJSONStatus(res, status, title, description, warning) {
    var json = {
        status: status,
        message: title,
        description: description
    };
    
    // Add optional warning message.
    if (warning)
        json.warning = warning;
        
    res.status(status).json(json);
}
