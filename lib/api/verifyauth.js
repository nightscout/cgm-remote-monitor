'use strict';

var consts = require('../constants');
var env = require('../../env')( );

function configure (app, wares) {
  var express = require('express'),
      api = express.Router( );

  function config_authed (app, api, wares) {

    api.get('/verifyauth', function(req, res) {
      var api_secret = env.api_secret;
      var secret = req.params.secret ? req.params.secret : req.header('api-secret');
      var unauthorized = (typeof api_secret === 'undefined' || secret !== api_secret);
      res.sendJSONStatus(res, consts.HTTP_OK, unauthorized ? 'UNAUTHORIZED' : 'OK');
    });
  }

  if (app.enabled('api')) {
    config_authed(app, api, wares);
  }

  return api;
}

module.exports = configure;

