'use strict';

var consts = require('../constants');

function configure (ctx) {
  var express = require('express'),
      api = express.Router( );

  api.get('/verifyauth', function(req, res) {
    ctx.authorization.resolveWithRequest(req, function resolved (err, result) {
      // this is used to see if req has api-secret equivalent authorization
      var authorized = !err && 
        ctx.authorization.checkMultiple('*:*:read', result.shiros);
      var response = {
        message: authorized ? 'OK' : 'UNAUTHORIZED',
        rolefound: result.subject ? 'FOUND' : 'NOTFOUND'
      }

      const httpStatus = authorized ? consts.HTTP_OK : consts.HTTP_UNAUTHORIZED;

      res.sendJSONStatus(res, httpStatus, response);
    });
  });

  return api;
}

module.exports = configure;
