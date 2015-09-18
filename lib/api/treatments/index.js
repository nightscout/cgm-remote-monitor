'use strict';

var consts = require('../../constants');

function configure (app, wares, ctx) {
  var express = require('express'),
    api = express.Router( );

  // invoke common middleware
  api.use(wares.sendJSONStatus);
  // text body types get handled as raw buffer stream
  api.use(wares.bodyParser.raw( ));
  // json body types get handled as parsed json
  api.use(wares.bodyParser.json( ));
  // also support url-encoded content-type
  api.use(wares.bodyParser.urlencoded({ extended: true }));

  // List treatments available
  api.get('/treatments/', function(req, res) {
    ctx.treatments.list(req.query, function (err, results) {
      return res.json(results);
    });
  });

  function config_authed (app, api, wares, ctx) {

    api.post('/treatments/', /*TODO: auth disabled for now, need to get login figured out... wares.verifyAuthorization, */ function(req, res) {
      var treatment = req.body;
      ctx.treatments.create(treatment, function (err, created) {
        if (err) {
          res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
        } else {
          res.json(created);
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

