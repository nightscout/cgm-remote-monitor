'use strict';

var consts = require('../../constants');
var url = require('url');

function configure(app, wares, ctx) {
  var express = require('express'),
    api = express.Router();

    /*
    TODO: Add swagger documentation to:

    lib/server/swagger.json
    lib/server/swagger.yaml
    */

  // invoke common middleware
  api.use(wares.sendJSONStatus);
  // text body types get handled as raw buffer stream
  api.use(wares.bodyParser.raw());
  // json body types get handled as parsed json
  api.use(wares.bodyParser.json());
  // also support url-encoded content-type
  api.use(wares.bodyParser.urlencoded({ extended: true }));

  api.use(ctx.authorization.isPermitted('api:remotecommands:read'));

  api.get('/remotecommands', function (req, res) {
    var query = req.query;
    if (!query.count) {
      // If there's a date search involved, default to a higher number of objects
      query.count = query.find ? 1000 : 100;
    }

    ctx.remotecommands.list(query, function (err, results) {
      res.json(results);
    });
  });

  api.get('/remotecommands/:id', function (req, res) {
    var query = req.query;

    query.find = {
      _id: req.params.id
    };

    ctx.remotecommands.list(query, function (err, results) {
      if (results === undefined || results.length == 0) {
        res.sendJSONStatus(res, 404, 'Missing', err);
      } else {
        res.json(results);
      }
    });
  });

  function config_authed(app, api, wares, ctx) {

    // create remote command
    api.post('/remotecommands/', ctx.authorization.isPermitted('api:remotecommands:create'), function (req, res) {
      var data = req.body;
      ctx.remotecommands.create(data, function (err, created) {
        if (err) {
          res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
          console.log('Error creating remotecommands', err);
        } else {
          console.log('Remote Command created', created);
          const locationURL = fullUrl(req) + created.insertedIds[0]
          if (req.body.sendNotification == true) {
            ctx.loop.sendNotification(req.body, req.connection.remoteAddress, function (err) {
              if (err) {
                res.status(consts.HTTP_INTERNAL_ERROR).send(err)
                console.log("error sending notification to Loop: ", err);
              } else {
                console.log('Remote Notification Sent', req.body);
                res.location(locationURL)
                res.json(created.ops);
              }
            });
          } else {
            res.location(locationURL)
            res.json(created.ops);
          }
        }
      });
    });

    // update remote command
    api.put('/remotecommands/:id', ctx.authorization.isPermitted('api:remotecommands:update'), function (req, res) {
      var update = req.body;
      
      ctx.remotecommands.save(req.params.id, update, function (err, updateResult) {
        if (err) {
          res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
          console.log('Error saving remote command');
          console.log(err);
        } else {
          if (updateResult.value == undefined || updateResult.value == null) {
            //TODO: Consider returning another error as 404 is not quite right.
            //This can happen if trying to update a command that is in Pending status, 
            //not a missing one.
            res.sendJSONStatus(res, 404, 'Missing', err);
            return;
          } else {
          //TODO: Return an error if the command was not found.
            res.json(updateResult);
            console.log('Remote Command updated', updateResult);
          }
        }
      });
    });

    /**
     * @function delete_records
     * Delete remotecommands.  The query logic works the same way as find/list. This
     * endpoint uses same search logic to remove records from the database.
     */
    function delete_records(req, res, next) {
      var query = req.query;

      console.log('Delete records with query: ', query);

      // remove using the query
      ctx.remotecommands.remove(query, function (err, stat) {
        if (err) {
          console.log('remotecommands delete error: ', err);
          next(err);
        }
        // yield some information about success of operation
        res.json(stat);

        console.log('remotecommands records deleted');

        next();
      });
    }

    api.delete('/remotecommands/:id', ctx.authorization.isPermitted('api:remotecommands:delete'), function (req, res, next) {
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
    api.delete('/remotecommands/', ctx.authorization.isPermitted('api:remotecommands:delete'), delete_records);

    /**
     * @function fullURL
     * Create a url from a request
     */
    function fullUrl(req) {
      return url.format({
        protocol: req.protocol,
        host: req.get('host'),
        pathname: req.originalUrl
      });
    }
  }

  if (app.enabled('api')) {
    config_authed(app, api, wares, ctx);
  }

  return api;
}

module.exports = configure;