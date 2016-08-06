'use strict';

var consts = require('../constants');

function configure (ctx) {
  var express = require('express'),
      api = express.Router( );

  api.get('/verifyauth', function(req, res) {
    ctx.authorization.resolveWithRequest(req, function resolved (err, result) {
      var authorized = !err && result.shiro.check('*');
      res.sendJSONStatus(res, consts.HTTP_OK, authorized ? 'OK' : 'UNAUTHORIZED');
    });
  });

  return api;
}

module.exports = configure;

