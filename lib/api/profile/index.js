'use strict';

var consts = require('../../constants');
var normalizeDeleteStatus = require('../shared/delete-status');
var objectIdValidation = require('../shared/objectid-validation');

function configure (app, wares, ctx) {
    var express = require('express'),
        api = express.Router( );

    // invoke common middleware
    api.use(wares.sendJSONStatus);
    // text body types get handled as raw buffer stream
    api.use(wares.rawParser);
    // json body types get handled as parsed json
    api.use(wares.jsonParser);
    // also support url-encoded content-type
    api.use(wares.urlencodedParser);
    // text body types get handled as raw buffer stream

    api.use(ctx.authorization.isPermitted('api:profile:read'));


   /**
   * @function query_models
   * Perform the standard query logic, translating API parameters into mongo
   * db queries in a fairly regimented manner.
   * This middleware executes the query, returning the results as JSON
   */
    function query_models (req, res, next) {
        var query = req.query;

        // If "?count=" is present, use that number to decide how many to return.
        if (!query.count) {
            query.count = consts.PROFILES_DEFAULT_COUNT;
        }

        // perform the query
        ctx.profile.list_query(query, function payload(err, profiles) {
            return res.json(profiles);
        });
    }

    // List profiles available
    api.get('/profiles/', query_models);

    // List profiles available
    api.get('/profile/', function(req, res) {
        const limit = req.query && req.query.count ? Number(req.query.count) : consts.PROFILES_DEFAULT_COUNT;
        ctx.profile.list(function (err, attribute) {
            return res.json(attribute);
        }, limit);
    });

    // List current active record (in current state LAST record is current active)
    api.get('/profile/current', function(req, res) {
        ctx.profile.last( function(err, records) {
            return res.json(records.length > 0 ? records[0] : null);
        });
    });

    function config_authed (app, api, wares, ctx) {
        function parseKeepCount (req) {
            var rawKeep = req.query && req.query.keep !== undefined ? req.query.keep : '100';
            var keep = Number(rawKeep);

            if (!Number.isSafeInteger(keep) || keep < 10 || keep > 10000) {
                return null;
            }

            return keep;
        }

        // create new record(s)
        // Supports both single object and array inputs (NightscoutKit sends arrays)
        api.post('/profile/', ctx.authorization.isPermitted('api:profile:create'), function(req, res) {
            var data = req.body;

            // Normalize to array (match treatments pattern)
            if (!Array.isArray(data)) {
                data = [data];
            }

            // Validate _id fields before storage (return 400 on invalid)
            var invalid = objectIdValidation.findInvalidId(data);
            if (invalid) {
                return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
                    'Invalid _id format', 'Must be 24-character hex string or omit for auto-generation. Got: ' + String(invalid.id));
            }

            // Purify each profile
            for (var i = 0; i < data.length; i++) {
                ctx.purifier.purifyObject(data[i]);
            }

            ctx.profile.create(data, function (err, created) {
                if (err) {
                    res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
                    console.log('Error creating profile');
                    console.log(err);
                } else {
                    res.json(created);
                    console.log('Profile(s) created', created.length);
                }
            });
        });

        // update record
        api.put('/profile/', ctx.authorization.isPermitted('api:profile:update'), function(req, res) {
            var data = req.body;

            // Validate _id if provided (required for PUT, must be valid format)
            if (!objectIdValidation.isValidObjectId(data._id)) {
                return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
                    'Invalid _id format', 'Must be 24-character hex string. Got: ' + String(data._id));
            }

            ctx.profile.save(data, function (err, created) {
                if (err) {
                    res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
                    console.log('Error saving profile');
                    console.log(err);
                } else {
                    res.json(created);
                    console.log('Profile saved', created);
                }

            });
        });

        api.delete('/profile/', ctx.authorization.isPermitted('api:profile:delete'), function(req, res) {
            var keepCount = parseKeepCount(req);

            if (keepCount === null) {
                return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
                    'Invalid keep count', 'Must be a whole number between 10 and 10000.');
            }

            ctx.profile.prune(keepCount, function (err, stat) {
                if (err) {
                    res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
                    console.log('Error pruning profiles');
                    console.log(err);
                } else {
                    res.json(normalizeDeleteStatus(stat));
                }
            });
        });

        api.delete('/profile/:_id', ctx.authorization.isPermitted('api:profile:delete'), function(req, res) {
            // Validate _id parameter
            if (!objectIdValidation.isValidObjectId(req.params._id)) {
                return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
                    'Invalid _id format', 'Must be 24-character hex string. Got: ' + String(req.params._id));
            }

          ctx.profile.remove(req.params._id, function ( ) {
            res.json({ });
          });
        });
    }

    if (app.enabled('api')) {
        config_authed(app, api, wares, ctx);
    }

    return api;
}

module.exports = configure;
