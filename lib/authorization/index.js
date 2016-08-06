'use strict';

var _ = require('lodash');
var jwt = require('jsonwebtoken');
var shiroTrie = require('shiro-trie');

var consts = require('./../constants');

var log_green = '\x1B[32m';
var log_reset = '\x1B[0m';
var LOG_SUCCESS = log_green + 'AUTH: ' + log_reset;

function mkopts (opts) {
  var options = opts && !_.isEmpty(opts) ? opts : { };
  if (!options.redirectDeniedURL) {
    options.redirectDeniedURL = null;
  }
  return options;
}

function init (env, ctx) {
  var authorization = { };
  var storage = authorization.storage = require('./storage')(env, ctx);
  var defaultRoles = (env.settings.authDefaultRoles || '').split(/[, :]/);

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

  function findByAccess (req) {
    if (req.query.token) {
      var accessToken = req.query.token;
      var authed = authorization.authorize(accessToken);
      if (authed && authed.token) {
        return authed.token;
      }
    }
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

  authorization.seenPermissions = [ ];

  authorization.expandedPermissions = function expandedPermissions ( ) {
    var permissions = shiroTrie.new();
    permissions.add(authorization.seenPermissions);
    return permissions;
  };

  authorization.isPermitted = function isPermitted (permission, opts) {


    opts = mkopts(opts);
    authorization.seenPermissions = _.chain(authorization.seenPermissions)
      .push(permission)
      .sort()
      .uniq()
      .value();

    function check(req, res, next) {

      if (authorizeAdminSecret(req)) {
        console.log(LOG_SUCCESS, 'api-secret');
        next( );
        return;
      }

      var token = extractToken(req) || findByAccess(req);

      var remoteIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

      var builtin = shiroTrie.new();
      var defaultPermissions = storage.rolesToPermissions(defaultRoles);
      builtin.add(defaultPermissions);
      if (token) {
        jwt.verify(token, env.api_secret, function result(err, verified) {
          if (err) {
            console.info('Error verifying Authorized Token', err);
            res.status(consts.HTTP_UNAUTHORIZED).send('Unauthorized - Invalid/Missing');
          } else {
            var resolved = storage.resolveSubjectAndPermissions(verified.accessToken);
            if (resolved.shiro.check(permission)) {
              console.log(LOG_SUCCESS, remoteIP, verified.accessToken , permission, '-- granted by token');
              next();
            } else if (builtin.check(permission)) {
              console.log(LOG_SUCCESS, remoteIP, verified.accessToken, permission, '-- granted by default, with token');
              next( );
            } else {
              res.sendJSONStatus(res, consts.HTTP_UNAUTHORIZED, 'Unauthorized', 'Invalid/Missing');
            }
          }
        });
      } else {
        if (builtin.check(permission)) {
          console.log(LOG_SUCCESS, remoteIP, permission, '-- granted by default, no token');
          return next( );
        }
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
