'use strict';

var consts = require('../constants');
var _ = require('lodash');
var slowDown = require('express-slow-down');

function configure (ctx) {
  var express = require('express'),
      api = express.Router( );
  const SLOWDOWN_WINDOW_MS = /*_.get(env, 'settings.slowdownWindowMs') || */ 30000;
  const SLOWDOWN_DELAY_AFTER = /* _.get(env, 'settings.slowdownDelayAfter') || */ 1;
  const SLOWDOWN_DELAY_MS = /* _.get(env, 'settings.slowdownDelayMs') || */ 5000;


  function canSkip (req, res) {
    return req.authInfo.message == 'OK';
  }

  var speedLimit = slowDown({
    windowMS: SLOWDOWN_WINDOW_MS,
    delayAfter: SLOWDOWN_DELAY_AFTER,
    delayMs: SLOWDOWN_DELAY_MS,
    skip: canSkip
  });

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
        rolefound: result.subject ? 'FOUND' : 'NOTFOUND',
        permissions: result.defaults ? 'DEFAULT' : 'ROLE'
      };
      req.authInfo = response;
      next( );
    });
  }, speedLimit, function verifyauth_json (req, res, next) {
    var response = req.authInfo;
    res.sendJSONStatus(res, consts.HTTP_OK, response);
  });

  return api;
}

module.exports = configure;
