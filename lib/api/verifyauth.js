'use strict';

var consts = require('../constants');

function configure (ctx) {
  var express = require('express'),
      api = express.Router( );

  api.get('/verifyauth', function(req, res, next) {
    ctx.authorization.resolveWithRequest(req, function resolved (err, result) {
      // this is used to see if req has api-secret equivalent authorization
      var canRead = !err && 
        ctx.authorization.checkMultiple('*:*:read', result.shiros);
      var canWrite = !err && 
        ctx.authorization.checkMultiple('*:*:write', result.shiros);
      var isAdmin = !err && 
        ctx.authorization.checkMultiple('*:*:admin', result.shiros);
      var authorized = canRead && !result.defaults;

      var response = {
        canRead,
        canWrite,
        isAdmin,
        message: authorized ? 'OK' : 'UNAUTHORIZED',
        required: true,
        is_permitted: authorized,
        rolefound: result.subject ? 'FOUND' : 'NOTFOUND',
        permissions: result.defaults ? 'DEFAULT' : 'ROLE'
      };
      req.authInfo = response;
      next( );
    });
  }, ctx.authorization.speedLimit, function verifyauth_json (req, res, next) {
    var response = req.authInfo;
    res.sendJSONStatus(res, consts.HTTP_OK, response);
  });

  return api;
}

module.exports = configure;
