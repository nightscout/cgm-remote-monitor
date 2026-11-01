'use strict';

var consts = require('../../constants');
var writeIntent = require('../../storage/write-intent');
var normalizeDeleteStatus = require('../shared/delete-status');
var sendQueryValidationError = require('../shared/query-error');
var objectIdValidation = require('../shared/objectid-validation');
var writePayload = require('../shared/write-payload');
var logPrivacy = require('../../server/log-privacy');

function configure (app, wares, ctx, env) {
    // DEBUG_LOGGING adds the records to these lines (BF-193).
    var debug = logPrivacy.debugLogging(env);
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
    function query_models (req, res) {
        var query = req.query;

        // If "?count=" is present, use that number to decide how many to return.
        if (!query.count) {
            query.count = consts.PROFILES_DEFAULT_COUNT;
        }

        // perform the query
        ctx.profile.list_query(query, function payload(err, profiles) {
            // `err` was ignored here entirely, so a failed read answered 200
            // with an undefined body. A refused filter now says which operator
            // was refused; every other failure keeps the shape the profile
            // endpoints already use for an unreadable collection.
            if (err) {
                if (sendQueryValidationError(res, err)) return;
                return res.status(consts.HTTP_INTERNAL_ERROR)
                    .json({status: consts.HTTP_INTERNAL_ERROR, message: 'Unable to read profiles'});
            }
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
            // Runs inside a promise handler: reading a null `records` here would
            // end the process, so a failed read answers an error instead.
            if (err) {
                if (sendQueryValidationError(res, err)) return;
                console.error('Error reading the current profile', err);
                return res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Internal Server Error');
            }
            return res.json(records && records.length > 0 ? records[0] : null);
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
            var normalized = writePayload.normalize(req.body);
            if (normalized.error === 'size') {
                return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
                    'Too many profile records', 'Maximum records per request: ' + writePayload.MAX_BATCH_ITEMS);
            }
            if (normalized.error) {
                return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
                    'Invalid profile payload', 'Expected an object or array of objects');
            }
            const data = normalized.documents;

            // Validate _id fields before storage (return 400 on invalid)
            var invalid = objectIdValidation.findInvalidId(data);
            if (invalid) {
                return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
                    'Invalid _id format', 'Must be 24-character hex string or omit for auto-generation. Got: ' + String(invalid.id));
            }

            // Iterate the validated, bounded array rather than a body length.
            data.forEach(function (profile) {
                ctx.purifier.purifyObject(profile);
            });

            // A POST can now merge a stored profile. Keep create-only uploads
            // and identical retries, but pass update access to the storage
            // preflight so a refused mixed batch cannot partially write.
            ctx.authorization.resolveWithRequest(req, function (authErr, permissions) {
                if (authErr) {
                    return res.sendJSONStatus(res, consts.HTTP_UNAUTHORIZED, 'Unauthorized', 'Invalid/Missing');
                }
                var canUpdate = ctx.authorization.checkMultiple('api:profile:update', permissions.shiros);
                ctx.profile.create(data, function (err, created) {
                    if (err && err.code === 'PROFILE_UPDATE_PERMISSION_REQUIRED') {
                        return res.sendJSONStatus(res, consts.HTTP_UNAUTHORIZED, 'Unauthorized', err.message);
                    }
                    if (err) {
                        res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
                        console.log('Error creating profile');
                        console.log(err);
                    } else {
                        // WRITE_RESEND=refuse (ID-RESEND-SWITCH): re-sends refused in their slot, 409.
                        var resendRefused = writeIntent.resendRefusals(created);
                        if (resendRefused > 0) res.append('Warning', writeIntent.resendWarning(resendRefused, data.length, 'profiles'));
                        res.json(created);
                        console.log('Profile(s) created', created.length);
                    }
                }, { canUpdate: canUpdate });
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

            ctx.purifier.purifyObject(data);

            ctx.profile.save(data, function (err, created) {
                if (writeIntent.isDeletedRecord(err)) {
                    // on-deleted (ID-Q3, WRITE_DELETED_EDIT=refuse): nothing was written.
                    res.sendJSONStatus(res, consts.HTTP_GONE, err.message);
                } else if (writeIntent.isIdentifierConflict(err)) {
                    // identifier-held (ID-RULE1-EDIT): nothing was written.
                    res.sendJSONStatus(res, consts.HTTP_CONFLICT, err.message);
                } else if (err) {
                    res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
                    console.log('Error saving profile');
                    console.log(err);
                } else {
                    res.json(created);
                    console.log('Profile saved', logPrivacy.recordForLog(created, { collection: 'profile', debug: debug }));
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
