'use strict';

var consts = require('../../constants');

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
    // Add format extension support
    api.use(wares.extensions(['json', 'csv', 'txt', 'tsv']));

    api.use(ctx.authorization.isPermitted('api:food:read'));

    /**
     * @function formatWithSeparator
     * Format food data as CSV/TSV
     */
    function formatWithSeparator(data, separator) {
      if (data === null || data.constructor !== Array || data.length == 0) return "";
      
      // Flatten the food data for CSV export
      var outputdata = [];
      data.forEach(function(f) {
        var food = {
          "_id": f._id || '',
          "name": f.name || '',
          "category": f.category || '',
          "subcategory": f.subcategory || '',
          "portions": JSON.stringify(f.portions || ''),
          "created_at": f.created_at || '',
          "carbs": f.carbs || '',
          "protein": f.protein || '',
          "fat": f.fat || '',
          "energy": f.energy || ''
        };
        outputdata.push(food);
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

    // List foods available
    api.get('/food/', function(req, res) {
      ctx.food.list(function (err, results) {
        if (err) {
          return res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
        }
        
        // Ensure we have results or return empty array
        if (!results) {
          results = [];
        }
        
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

      // create new record
      api.post('/food/', ctx.authorization.isPermitted('api:food:create'), function(req, res) {
        var data = req.body;
        ctx.food.create(data, function (err, created) {
          if (err) {
            res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            console.log('Error creating food');
            console.log(err);
          } else {
            res.json(created);
            console.log('food created',created);
          }
        });
      });

      // update record
      api.put('/food/', ctx.authorization.isPermitted('api:food:update'), function(req, res) {
        var data = req.body;
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

