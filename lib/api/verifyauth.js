'use strict';

var consts = require('../constants');

function configure (app, env) {
  var express = require('express'),
      api = express.Router( );

  api.get('/verifyauth', function(req, res) {
    var api_secret = env.api_secret;
    var secret = req.params.secret ? req.params.secret : req.header('api-secret');
    var authorized = (app.enabled('api') && api_secret && api_secret.length > 12) ? (secret === api_secret) : false;
    res.sendJSONStatus(res, consts.HTTP_OK, authorized ? 'OK' : 'UNAUTHORIZED');
  });

  return api;
}

module.exports = configure;

