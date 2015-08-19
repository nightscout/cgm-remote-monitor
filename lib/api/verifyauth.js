'use strict';

var consts = require('../constants');

function configure (app, wares) {
  var express = require('express'),
      api = express.Router( );

  function config_authed (app, api, wares) {

    // create new record
    api.get('/verifyauth', wares.verifyAuthorization, function(req, res) {
      res.sendJSONStatus(res, consts.HTTP_OK, 'OK');
    });
  }

  if (app.enabled('api')) {
    config_authed(app, api, wares);
  }

  return api;
}

module.exports = configure;

