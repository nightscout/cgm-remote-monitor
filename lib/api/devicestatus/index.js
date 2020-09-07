'use strict';

const consts = require('../../constants');
const moment = require('moment');
const { query } = require('express');
const _take = require('lodash/take');
const _ = require('lodash');

function configure (app, wares, ctx, env) {
  var express = require('express')
    , api = express.Router();

  // invoke common middleware
  api.use(wares.sendJSONStatus);
  // text body types get handled as raw buffer stream
  api.use(wares.bodyParser.raw());
  // json body types get handled as parsed json
  api.use(wares.bodyParser.json());
  // also support url-encoded content-type
  api.use(wares.bodyParser.urlencoded({ extended: true }));

  api.use(ctx.authorization.isPermitted('api:devicestatus:read'));

  function processDates(results) {
    // Support date de-normalization for older clients
    
    if (env.settings.deNormalizeDates) {
      const r = [];
      results.forEach(function(e) {
        if (e.created_at && Object.prototype.hasOwnProperty.call(e, 'utcOffset')) {
          const d = moment(e.created_at).utcOffset(e.utcOffset);
          e.created_at = d.toISOString(true);
          delete e.utcOffset;
        }
        r.push(e);
      });
      return r;
    } else {
      return results;
    }
  }

  // List settings available
  api.get('/devicestatus/', function(req, res) {
    var q = req.query;
    if (!q.count) {
      q.count = 10;
    }

    const inMemoryData = ctx.ddata.shadow.devicestatus ? ctx.ddata.shadow.devicestatus : [];
    const canServeFromMemory = inMemoryData.length >= q.count && Object.keys(q).length == 1 ? true : false;

    if (canServeFromMemory) {
      const sorted = _.sortBy(inMemoryData, function(item) {
        return -item.mills;
      });

      return res.json(processDates(_take(sorted, q.count)));
    }

    ctx.devicestatus.list(q, function(err, results) {
      return res.json(processDates(results));
    });
  });

  function config_authed (app, api, wares, ctx) {

    function doPost (req, res) {
      var obj = req.body;
      ctx.devicestatus.create(obj, function(err, created) {
        if (err) {
          res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
        } else {
          res.json(created);
        }
      });
    }

    api.post('/devicestatus/', ctx.authorization.isPermitted('api:devicestatus:create'), doPost);

    /**
     * @function delete_records
     * Delete devicestatus.  The query logic works the same way as find/list.  This
     * endpoint uses same search logic to remove records from the database.
     */
    function delete_records (req, res, next) {
      var query = req.query;
      if (!query.count) {
        query.count = 10
      }

      console.log('Delete records with query: ', query);

      // remove using the query
      ctx.devicestatus.remove(query, function(err, stat) {
        if (err) {
          console.log('devicestatus delete error: ', err);
          return next(err);
        }
        // yield some information about success of operation
        res.json(stat);

        console.log('devicestatus records deleted');

        return next();
      });
    }

    api.delete('/devicestatus/:id', ctx.authorization.isPermitted('api:devicestatus:delete'), function(req, res, next) {
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
    api.delete('/devicestatus/', ctx.authorization.isPermitted('api:devicestatus:delete'), delete_records);
  }

  if (app.enabled('api')) {
    config_authed(app, api, wares, ctx);
  }

  return api;
}

module.exports = configure;
