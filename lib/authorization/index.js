'use strict';

var _ = require('lodash');
var jwt = require('jsonwebtoken');

var consts = require('./../constants');

function init (env, ctx) {
  var authorization = { };
  var storage = authorization.storage = require('./storage')(env, ctx);

  function extractToken (req) {
    var token;
    var authorization = req.header('Authorization');

    if (authorization) {
      var parts = authorization.split(' ');
      if (parts.length === 2 && parts[0] === 'Bearer') {
        token = parts[1];
      }
    }

    return token;
  }

  function authorizeAdminSecret (req) {
    var secret = req.query && req.query.secret ? req.query.secret : req.header('api-secret');

    // try to get the scret from the body, but don't leave it there
    if (!secret && req.body) {
      if (_.isArray(req.body) && req.body.length > 0) {
        secret = req.body[0].secret;
        delete req.body[0].secret;
      } else {
        secret = req.body.secret;
        delete req.body.secret;
      }
    }

    return (env.api_secret && env.api_secret.length > 12) ? (secret === env.api_secret) : false;

  }

  authorization.isPermitted = function isPermitted (permission) {

    function check(req, res, next) {

      if (authorizeAdminSecret(req)) {
        next( );
        return;
      }

      var token = extractToken(req);

      if (token) {
        jwt.verify(token, env.api_secret, function result(err, verified) {
          if (err) {
            console.info('Error verifying Authorized Token', err);
            res.status(consts.HTTP_UNAUTHORIZED).send('Unauthorized - Invalid/Missing');
          } else {
            console.info('Verified Authorization', verified);
            var permissions = storage.findSubjectPermissions(verified.accessToken);
            console.info('checking', permissions, 'for', permission);
            if (permissions.check(permission)) {
              next( );
            } else {
              res.sendJSONStatus(res, consts.HTTP_UNAUTHORIZED, 'Unauthorized', 'Invalid/Missing');
            }
          }
        });
      } else {
        res.sendJSONStatus(res, consts.HTTP_UNAUTHORIZED, 'Unauthorized', 'Invalid/Missing');
      }

    }

    return check;
  };

  authorization.authorize = function authorize (accessToken) {
    var subject = storage.findSubject(accessToken);

    var authorized = null;

    if (subject) {
      var token = jwt.sign( { accessToken: subject.accessToken }, env.api_secret, { expiresIn: '1h' } );

      //decode so we can tell the client the issued and expired times
      var decoded = jwt.decode(token);

      authorized = {
        token: token
        , sub: subject.name
        , permissions: storage.rolesToPermissions(subject.roles)
        , iat: decoded.iat
        , exp: decoded.exp
      };
    }

    return authorized;
  };

  authorization.endpoints = require('./endpoints')(env, authorization);

  return authorization;
}

module.exports = init;