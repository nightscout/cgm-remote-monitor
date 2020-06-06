'use strict';

var _forEach = require('lodash/forEach');
var _isNil = require('lodash/isNil');
var _isArray = require('lodash/isArray');

var consts = require('../../constants');
var moment = require('moment');

function configure (app, wares, ctx, env) {
  var express = require('express')
    , api = express.Router();

  api.use(wares.compression());
  api.use(wares.bodyParser({
    limit: 1048576 * 50
  }));
  // text body types get handled as raw buffer stream
  api.use(wares.bodyParser.raw({
    limit: 1048576
  }));
  // json body types get handled as parsed json
  api.use(wares.bodyParser.json({
    limit: 1048576
  }));
  // also support url-encoded content-type
  api.use(wares.bodyParser.urlencoded({
    limit: 1048576
    , extended: true
  }));
  // invoke common middleware
  api.use(wares.sendJSONStatus);

  api.use(ctx.authorization.isPermitted('api:treatments:read'));

  // List treatments available
  api.get('/treatments', function(req, res) {
    var ifModifiedSince = req.get('If-Modified-Since');
    ctx.treatments.list(req.query, function(err, results) {
      var d1 = null;

      const deNormalizeDates = env.settings.deNormalizeDates;

      _forEach(results, function clean (t) {
        t.carbs = Number(t.carbs);
        t.insulin = Number(t.insulin);

        if (deNormalizeDates && Object.prototype.hasOwnProperty.call(t, 'utcOffset')) {
            const d = moment(t.created_at).utcOffset(t.utcOffset);
            t.created_at = d.toISOString(true);
            delete t.utcOffset;
        }

        var d2 = null;

        if (Object.prototype.hasOwnProperty.call(t, 'created_at')) {
          d2 = new Date(t.created_at);
        } else {
          if (Object.prototype.hasOwnProperty.call(t, 'timestamp')) {
            d2 = new Date(t.timestamp);
          }
        }

        if (d2 == null) { return; }

        if (d1 == null || d2.getTime() > d1.getTime()) {
          d1 = d2;
        }
      });

      if (!_isNil(d1)) res.setHeader('Last-Modified', d1.toUTCString());

      if (ifModifiedSince && d1.getTime() <= moment(ifModifiedSince).valueOf()) {
        res.status(304).send({
          status: 304
          , message: 'Not modified'
          , type: 'internal'
        });
        return;
      } else {
        return res.json(results);
      }
    });
  });

  function config_authed (app, api, wares, ctx) {

    function post_response (req, res) {
      var treatments = req.body;

      if (!_isArray(treatments)) {
        treatments = [treatments];
      }

      ctx.treatments.create(treatments, function(err, created) {
        if (err) {
          console.log('Error adding treatment', err);
          res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
        } else {
          console.log('Treatment created');
          res.json(created);
        }
      });
    }

    api.post('/treatments/', wares.bodyParser({
      limit: 1048576 * 50
    }), ctx.authorization.isPermitted('api:treatments:create'), post_response);

    /**
     * @function delete_records
     * Delete treatments.  The query logic works the same way as find/list.  This
     * endpoint uses same search logic to remove records from the database.
     */
    function delete_records (req, res, next) {
      var query = req.query;
      if (!query.count) {
        query.count = 10
      }

      console.log('Delete records with query: ', query);

      // remove using the query
      ctx.treatments.remove(query, function(err, stat) {
        if (err) {
          console.log('treatments delete error: ', err);
          return next(err);
        }
        // yield some information about success of operation
        res.json(stat);

        console.log('treatments records deleted');

        return next();
      });
    }

    api.delete('/treatments/:id', ctx.authorization.isPermitted('api:treatments:delete'), function(req, res, next) {
      if (!req.query.find) {
        req.query.find = {
          _id: req.params.id
        };
      } else {
        req.query.find._id = req.params.id;
      }

      if (req.query.find._id === '*') {
        // match any record id
        delete req.query.find._id;
      }
      next();
    }, delete_records);

    // delete record that match query
    api.delete('/treatments/', ctx.authorization.isPermitted('api:treatments:delete'), delete_records);

    // update record
    api.put('/treatments/', ctx.authorization.isPermitted('api:treatments:update'), function(req, res) {
      var data = req.body;
      ctx.treatments.save(data, function(err, created) {
        if (err) {
          res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
          console.log('Error saving treatment');
          console.log(err);
        } else {
          res.json(created);
          console.log('Treatment saved', data);
        }
      });
    });
  }

  if (app.enabled('api') && app.enabled('careportal')) {
    config_authed(app, api, wares, ctx);
  }

  return api;
}

module.exports = configure;
