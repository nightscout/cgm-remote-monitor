'use strict';

var consts = require('../../constants');
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
        var data = req.body;

        // Normalize to array for consistent handling
        if (!Array.isArray(data)) {
            data = [data];
        }

        // Validate _id fields before storage (return 400 on invalid)
        var invalid = objectIdValidation.findInvalidId(data);
        if (invalid) {
            return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
                'Invalid _id format', 'Must be 24-character hex string or omit for auto-generation. Got: ' + String(invalid.id));
        }

        ctx.food.create(data, function (err, created) {
          if (err) {
            res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            console.log('Error creating food');
            console.log(err);
          } else {
            res.json(created);
            console.log('food created', created);
          }
        });
      });

      // update record(s) - supports both single object and array input
      api.put('/food/', ctx.authorization.isPermitted('api:food:update'), function(req, res) {
        var data = req.body;

        // Normalize to array for consistent handling
        if (!Array.isArray(data)) {
            data = [data];
        }

        // Validate _id fields before storage (return 400 on invalid)
        var invalid = objectIdValidation.findInvalidId(data);
        if (invalid) {
            return res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST,
                'Invalid _id format', 'Must be 24-character hex string. Got: ' + String(invalid.id));
        }

        ctx.food.save(data, function (err, created) {
          if (err) {
            res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            console.log('Error saving food');
            console.log(err);
          } else {
            res.json(created);
            console.log('food saved');
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
        });
      });
    }

    if (app.enabled('api')) {
      config_authed(app, api, wares, ctx);
    }

    return api;
}

module.exports = configure;
