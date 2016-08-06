'use strict';

var consts = require('../constants');

function configure (ctx) {
  var express = require('express'),
      api = express.Router( );

  api.get('/verifyauth', function(req, res) {
    ctx.authorization.resolveWithRequest(req, function resolved (err, result) {

      // this is used to see if req has api-secret equivalent authorization
      var authorized = !err &&
        result.shiro.check('*:*:create,update,delete') && //can write to everything
        result.shiro.check('admin:*:*:*'); //full admin permissions too

      res.sendJSONStatus(res, consts.HTTP_OK, authorized ? 'OK' : 'UNAUTHORIZED');
    });
  });

  return api;
}

module.exports = configure;

