'use strict';

var consts = require('../../constants');

function configure (app, wares, ctx) {
  var express = require('express'),
    api = express.Router( );

  api.use(wares.compression( ));
  api.use(wares.bodyParser({limit: 1048576 * 50}));
  // text body types get handled as raw buffer stream
  api.use(wares.bodyParser.raw({limit: 1048576 }));
  // json body types get handled as parsed json
  api.use(wares.bodyParser.json({limit: 1048576 }));
  // also support url-encoded content-type
  api.use(wares.bodyParser.urlencoded({limit: 1048576 , extended: true }));
  // invoke common middleware
  api.use(wares.sendJSONStatus);

  // List treatments available
  api.get('/treatments/', function(req, res) {
    ctx.treatments.list(req.query, function (err, results) {
      return res.json(results);
    });
  });

  function config_authed (app, api, wares, ctx) {

    function post_response(req, res) {
      var treatment = req.body;
      ctx.treatments.create(treatment, function (err, created) {
        if (err) {
          console.log('Error adding treatment', err);
          res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
        } else {
          console.log('Treatment created');
          res.json(created);
        }
      });
    }
    if (app.settings.treatments_auth) {
      api.post('/treatments/', wares.bodyParser({limit: 1048576 * 50 }), wares.verifyAuthorization, post_response);
    } else  {
      api.post('/treatments/', wares.bodyParser({limit: 1048576 * 50 }), post_response);
    }
    api.delete('/treatments/:_id', wares.verifyAuthorization, function(req, res) {
      ctx.treatments.remove(req.params._id, function ( ) {
        res.json({ });
      });
    });

    // update record
    api.put('/treatments/', wares.verifyAuthorization, function(req, res) {
      var data = req.body;
      ctx.treatments.save(data, function (err, created) {
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

