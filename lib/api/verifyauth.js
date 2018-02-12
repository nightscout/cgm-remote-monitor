'use strict';

var consts = require('../constants');

function configure (ctx) {
  var express = require('express'),
      api = express.Router( );

  api.get('/verifyauth', function(req, res) {
    ctx.authorization.resolveWithRequest(req, function resolved (err, result) {

      // this is used to see if req has api-secret equivalent authorization
      var authorized = !err &&
        ctx.authorization.checkMultiple('*:*:create,update,delete', result.shiros) && //can write to everything
        ctx.authorization.checkMultiple('admin:*:*:*', result.shiros); //full admin permissions too

      res.sendJSONStatus(res, consts.HTTP_OK, authorized ? 'OK' : 'UNAUTHORIZED');
    });
  });

  return api;
}

module.exports = configure;

