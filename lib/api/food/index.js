'use strict';

var consts = require('../../constants');
var writeIntent = require('../../storage/write-intent');
var objectIdValidation = require('../shared/objectid-validation');
var writePayload = require('../shared/write-payload');
var batchReply = require('../shared/batch-reply');

function configure (app, wares, ctx, env) {
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
    // shortcut to use extension to specify output content-type

    api.use(ctx.authorization.isPermitted('api:food:read'));

    // List foods available
    api.get('/food/', function(req, res) {
      ctx.food.list(function (err, attribute) {
        return res.json(attribute);
      });
    });

    api.get('/food/quickpicks', function(req, res) {
      ctx.food.listquickpicks(function (err, attribute) {
        return res.json(attribute);
      });
    });

    api.get('/food/regular', function(req, res) {
      ctx.food.listregular(function (err, attribute) {
        return res.json(attribute);
      });
    });

    function config_authed (app, api, wares, ctx) {

      // create new record(s) - supports both single object and array input
      api.post('/food/', ctx.authorization.isPermitted('api:food:create'), function(req, res) {
        var normalized = writePayload.normalize(req.body);
        if (normalized.error === 'size') {
          return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
            'Too many food records', 'Maximum records per request: ' + writePayload.MAX_BATCH_ITEMS);
        }
        if (normalized.error) {
          return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
            'Invalid food payload', 'Expected an object or array of objects');
        }
        var data = normalized.documents;

        // The opt-in to per-item results (Nightscout-Write-Results: items, or
        // ?results=items): a non-hex _id then refuses its item, not the batch.
        var wanted = batchReply.requested(req);
        if (wanted && wanted.error) return batchReply.sendRequestError(res, wanted);
        var optIn = Boolean(wanted && wanted.optIn);

        // Validate _id fields before storage (return 400 on invalid)
        var invalid = optIn ? null : objectIdValidation.findInvalidId(data);
        if (invalid) {
            return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
                'Invalid _id format', 'Must be 24-character hex string or omit for auto-generation. Got: ' + String(invalid.id));
        }

        // ID-BATCH (R1): one slot per submitted record, built by index from
        // the refusals made here and the storage's answer for the records
        // written (lib/api/shared/batch-reply.js).
        var batch = batchReply.plan(data, { env: env, optIn: optIn, objectId: true });
        var replyOpts = { optIn: optIn, noun: 'food' };
        function reply (created) {
          batchReply.send(res, batchReply.build(batch, created || [], replyOpts), replyOpts);
        }
        if (batch.accepted.length === 0 && batch.n > 0) return reply([]);

        ctx.food.create(batch.accepted, function (err, created) {
          if (err) {
            res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            console.log('Error creating food');
            console.log(err);
          } else {
            reply(created);
            console.log('food created', created);
            ctx.bus.emit('data-received');
          }
        });
      });

      // update record(s) - supports both single object and array input
      api.put('/food/', ctx.authorization.isPermitted('api:food:update'), function(req, res) {
        var normalized = writePayload.normalize(req.body);
        if (normalized.error === 'size') {
          return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
            'Too many food records', 'Maximum records per request: ' + writePayload.MAX_BATCH_ITEMS);
        }
        if (normalized.error) {
          return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
            'Invalid food payload', 'Expected an object or array of objects');
        }
        var data = normalized.documents;

        // Validate _id fields before storage (return 400 on invalid)
        var invalid = objectIdValidation.findInvalidId(data);
        if (invalid) {
            return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
                'Invalid _id format', 'Must be 24-character hex string. Got: ' + String(invalid.id));
        }

        ctx.food.save(data, function (err, created) {
          if (writeIntent.isDeletedRecord(err)) {
            // on-deleted (ID-Q3, WRITE_DELETED_EDIT=refuse): nothing was written.
            res.sendJSONStatus(res, consts.HTTP_GONE, err.message);
          } else if (writeIntent.isIdentifierConflict(err)) {
            // identifier-held (ID-RULE1-EDIT): nothing was written.
            res.sendJSONStatus(res, consts.HTTP_CONFLICT, err.message);
          } else if (err) {
            res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            console.log('Error saving food');
            console.log(err);
          } else {
            res.json(created);
            console.log('food saved');
            ctx.bus.emit('data-received');
          }
        });
      });
      // delete record
      api.delete('/food/:_id', ctx.authorization.isPermitted('api:food:delete'), function(req, res) {
        // Validate _id parameter
        if (!objectIdValidation.isValidObjectId(req.params._id)) {
            return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
                'Invalid _id format', 'Must be 24-character hex string. Got: ' + String(req.params._id));
        }
        ctx.food.remove(req.params._id, function ( ) {
        res.json({ });
        ctx.bus.emit('data-received');
        });
      });
    }

    if (app.enabled('api')) {
      config_authed(app, api, wares, ctx);
    }

    return api;
}

module.exports = configure;
