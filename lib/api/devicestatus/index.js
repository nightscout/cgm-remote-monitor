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
  api.use(wares.rawParser);
  // json body types get handled as parsed json
  api.use(wares.jsonParser);
  // also support url-encoded content-type
  api.use(wares.urlencodedParser);
  // Add format extension support
  api.use(wares.extensions(['json', 'csv', 'txt', 'tsv']));

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

  /**
   * @function formatWithSeparator
   * Format devicestatus data as CSV/TSV
   */
  function formatWithSeparator(data, separator) {
    if (data === null || data.constructor !== Array || data.length == 0) return "";
    
    // Flatten the devicestatus data for CSV export
    var outputdata = [];
    data.forEach(function(d) {
      var devicestatus = {
        "_id": d._id || '',
        "device": d.device || '',
        "created_at": d.created_at || '',
        "mills": d.mills || '',
        "uploaderBattery": d.uploaderBattery || '',
        "pump": JSON.stringify(d.pump || ''),
        "openaps": JSON.stringify(d.openaps || ''),
        "loop": JSON.stringify(d.loop || '')
      };
      outputdata.push(devicestatus);
    });
    
    if (outputdata.length === 0) return "";
    
    var fields = Object.keys(outputdata[0]);
    var replacer = function(key, value) {
      return value === null ? '' : value;
    };
    // Create header row
    var csv = [fields.join(separator)];
    // Add data rows
    csv = csv.concat(outputdata.map(function(row) {
      return fields.map(function(fieldName) {
        return JSON.stringify(row[fieldName], replacer);
      }).join(separator);
    }));
    return csv.join('\r\n');
  }

  // List settings available
  api.get('/devicestatus/', function(req, res) {
    var q = req.query;
    if (!q.count) {
      q.count = 10;
    }

    const inMemoryData = ctx.cache.devicestatus ? ctx.cache.devicestatus : [];
    // Only use in-memory cache if count is reasonable (not attempting a large export)
    const canServeFromMemory = inMemoryData.length >= q.count && Object.keys(q).length == 1 && q.count < 10000 ? true : false;

    var results;
    if (canServeFromMemory) {
      const sorted = _.sortBy(inMemoryData, function(item) {
        return -item.mills;
      });
      results = processDates(_take(sorted, q.count));
      return serveResponse(req, res, results);
    }

    ctx.devicestatus.list(q, function(err, results) {
      if (err) {
        return res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
      }
      results = processDates(results);
      return serveResponse(req, res, results);
    });
  });

  function serveResponse(req, res, results) {
    return res.format({
      'text/plain': function() {
        var output = formatWithSeparator(results, "\t");
        res.send(output);
      },
      'text/tab-separated-values': function() {
        var output = formatWithSeparator(results, '\t');
        res.send(output);
      },
      'text/csv': function() {
        var output = formatWithSeparator(results, ',');
        res.send(output);
      },
      'application/json': function() {
        res.json(results);
      },
      'default': function() {
        res.json(results);
      }
    });
  }

  function config_authed (app, api, wares, ctx) {

    function doPost (req, res) {
      var obj = req.body;

      ctx.purifier.purifyObject(obj);
  
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
