'use strict';

var consts = require('../../constants');

function configure(app, wares, ctx) {
  var express = require('express'),
    api = express.Router();

  // invoke common middleware
  api.use(wares.sendJSONStatus);
  // text body types get handled as raw buffer stream
  api.use(wares.bodyParser.raw());
  // json body types get handled as parsed json
  api.use(wares.bodyParser.json());
  // also support url-encoded content-type
  api.use(wares.bodyParser.urlencoded({ extended: true }));

  api.use(ctx.authorization.isPermitted('api:remotecommands:read'));

  // get remote commands
  api.get('/remotecommands/', function (req, res) {
    var query = req.query;
    if (!query.count) {
      // If there's a date search involved, default to a higher number of objects
      query.count = query.find ? 1000 : 100;
    }

    ctx.remotecommands.list(query, function (err, results) {
      return res.json(results);
    });
  });

  function config_authed(app, api, wares, ctx) {

    // create remote command
    api.post('/remotecommands/', ctx.authorization.isPermitted('api:remotecommands:create'), async function (req, res) {
      var data = req.body;
      ctx.remotecommands.create(data, function (err, created) {
        if (err) {
          res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
          console.log('Error creating remotecommands');
          console.log(err);
        } else {
          if (req.body.sendNotification == true) { 
            sendPushNotification(req, res) 
          } else {
            res.json(created.ops);
          }
          console.log('Remote Command created', created);
        }
      });
    });

    // update remote command
    api.put('/remotecommands/', ctx.authorization.isPermitted('api:remotecommands:update'), function (req, res) {
      var data = req.body;
      ctx.remotecommands.save(data, function (err, created) {
        if (err) {
          res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
          console.log('Error saving remote command');
          console.log(err);
        } else {
          //TODO: Not sure if you want to return anything?
          //This doesn't seem to show up in the body anyways.
          //Suggestion not to: https://stackoverflow.com/questions/797834
          res.json(created);
          console.log('Remote Command updated', created);
        }
      });
    });

    function sendPushNotification(req, res) {
      ctx.loop.sendNotification(req.body, req.connection.remoteAddress, function (error) {
        if (error) {
          res.status(consts.HTTP_INTERNAL_ERROR).send(error)
          console.log("error sending notification to Loop: ", error);
        } else {
          res.sendStatus(consts.HTTP_OK);
        }
      });
    }

    /**
     * @function delete_records
     * Delete remotecommands.  The query logic works the same way as find/list.  This
     * endpoint uses same search logic to remove records from the database.
     */
    function delete_records(req, res, next) {
      var query = req.query;
      if (!query.count) {
        query.count = 10
      }

      console.log('Delete records with query: ', query);

      // remove using the query
      ctx.remotecommands.remove(query, function (err, stat) {
        if (err) {
          console.log('remotecommands delete error: ', err);
          return next(err);
        }
        // yield some information about success of operation
        res.json(stat);

        console.log('remotecommands records deleted');

        return next();
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
  }

  if (app.enabled('api')) {
    config_authed(app, api, wares, ctx);
  }

  return api;
}

module.exports = configure;