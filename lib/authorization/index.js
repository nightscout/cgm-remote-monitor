'use strict';

var _ = require('lodash');
var jwt = require('jsonwebtoken');
var shiroTrie = require('shiro-trie');

var consts = require('./../constants');

var log_green = '\x1B[32m';
var log_red = '\x1b[31m';
var log_reset = '\x1B[0m';
var LOG_GRANTED = log_green + 'GRANTED: ' + log_reset;
var LOG_DENIED  = log_red   + 'DENIED:  ' + log_reset;

function mkopts (opts) {
  var options = opts && !_.isEmpty(opts) ? opts : { };
  if (!options.redirectDeniedURL) {
    options.redirectDeniedURL = null;
  }
  return options;
}

function getRemoteIP (req) {
  return req.headers['x-forwarded-for'] || req.connection.remoteAddress;
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

    if (!token && req.auth_token) {
      token = req.auth_token;
    }

    if (!token) {
      token = authorizeAccessToken(req);
    }

    if (token) {
      req.auth_token = token;
    }

    return token;
  }

  authorization.extractToken = extractToken;

  function authorizeAccessToken (req) {

    var accessToken = req.query.token;

    if (!accessToken && req.body) {
      if (_.isArray(req.body) && req.body.length > 0 && req.body[0].token) {
        accessToken = req.body[0].token;
        delete req.body[0].token;
      } else if (req.body.token) {
        accessToken = req.body.token;
        delete req.body.token;
      }
    }

    var authToken = null;

    if (accessToken) {
      // make an auth token on the fly, based on an access token
      var authed = authorization.authorize(accessToken);
      if (authed && authed.token) {
        authToken = authed.token;
      }
    }

    return authToken;
  }

  function adminSecretFromRequest (req) {
    var secret = req.query && req.query.secret ? req.query.secret : req.header('api-secret');

    if (!secret && req.api_secret) {
      //see if we already got the secret from the body, since it gets deleted
      secret = req.api_secret;
    } else if (!secret && req.body) {
      // try to get the secret from the body, but don't leave it there
      if (_.isArray(req.body) && req.body.length > 0 && req.body[0].secret) {
        secret = req.body[0].secret;
        delete req.body[0].secret;
      } else if (req.body.secret) {
        secret = req.body.secret;
        delete req.body.secret;
      }
    }

    if (secret) {
      // store the secret hash on the request since the req may get processed again
      req.api_secret = secret;
    }

    return secret;
  }

 function authorizeAdminSecretWithRequest (req) {
    return authorizeAdminSecret(adminSecretFromRequest(req));
  }

  function authorizeAdminSecret (secret) {
    return (env.api_secret && env.api_secret.length > 12) ? (secret === env.api_secret) : false;
  }

  authorization.seenPermissions = [ ];

  authorization.expandedPermissions = function expandedPermissions ( ) {
    var permissions = shiroTrie.new();
    permissions.add(authorization.seenPermissions);
    return permissions;
  };

  authorization.resolveWithRequest = function resolveWithRequest (req, callback) {
    authorization.resolve({
      api_secret: adminSecretFromRequest(req)
      , token: extractToken(req)
    }, callback);
  };

  authorization.checkMultiple = function checkMultiple(permission, shiros) {
    var found = _.find(shiros, function checkEach (shiro) {
      return shiro && shiro.check(permission);
    });
    return _.isObject(found);
  };

  authorization.resolve = function resolve (data, callback) {

    var defaultShiros = storage.rolesToShiros(defaultRoles);

    if (storage.doesAccessTokenExist(data.api_secret)) {
      authorization.resolveAccessToken (data.api_secret, callback, defaultShiros);
      return;
    }

    if (authorizeAdminSecret(data.api_secret)) {
      var admin = shiroTrie.new();
      admin.add(['*']);
      return callback(null, { shiros: [ admin ] });
    }

    if (data.token) {
      jwt.verify(data.token, env.api_secret, function result(err, verified) {
        if (err) {
          return callback(err, { shiros: [ ] });
        } else {
          authorization.resolveAccessToken (verified.accessToken, callback, defaultShiros);
        }
      });
    } else {
      return callback(null, { shiros: defaultShiros });
    }

  };

  authorization.resolveAccessToken = function resolveAccessToken (accessToken, callback, defaultShiros) {

    if (!defaultShiros) {
      defaultShiros = storage.rolesToShiros(defaultRoles);
    }

    let resolved = storage.resolveSubjectAndPermissions(accessToken);
    if (!resolved || !resolved.subject) {
      return callback('Subject not found', null);
    }

    let shiros = resolved.shiros.concat(defaultShiros);
    return callback(null, { shiros: shiros, subject: resolved.subject });
  };

  authorization.isPermitted = function isPermitted (permission, opts) {


    opts = mkopts(opts);
    authorization.seenPermissions = _.chain(authorization.seenPermissions)
      .push(permission)
      .sort()
      .uniq()
      .value();

    function check(req, res, next) {

      var remoteIP = getRemoteIP(req);

      var secret = adminSecretFromRequest(req);
      var defaultShiros = storage.rolesToShiros(defaultRoles);

      if (storage.doesAccessTokenExist(secret)) {
        var resolved = storage.resolveSubjectAndPermissions (secret);
        
        if (authorization.checkMultiple(permission, resolved.shiros)) {
          console.log(LOG_GRANTED, remoteIP, resolved.accessToken , permission);
          next();
        } else if (authorization.checkMultiple(permission, defaultShiros)) {
          console.log(LOG_GRANTED, remoteIP, resolved.accessToken, permission, 'default');
          next( );
        } else {
          console.log(LOG_DENIED, remoteIP, resolved.accessToken, permission);
          res.sendJSONStatus(res, consts.HTTP_UNAUTHORIZED, 'Unauthorized', 'Invalid/Missing');
        }
        return;
      }

      if (authorizeAdminSecretWithRequest(req)) {
        console.log(LOG_GRANTED, remoteIP, 'api-secret', permission);
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
            var resolved = storage.resolveSubjectAndPermissions(verified.accessToken);
            if (authorization.checkMultiple(permission, resolved.shiros)) {
              console.log(LOG_GRANTED, remoteIP, verified.accessToken , permission);
              next();
            } else if (authorization.checkMultiple(permission, defaultShiros)) {
              console.log(LOG_GRANTED, remoteIP, verified.accessToken, permission, 'default');
              next( );
            } else {
              console.log(LOG_DENIED, remoteIP, verified.accessToken, permission);
              res.sendJSONStatus(res, consts.HTTP_UNAUTHORIZED, 'Unauthorized', 'Invalid/Missing');
            }
          }
        });
      } else {
        if (authorization.checkMultiple(permission, defaultShiros)) {
          console.log(LOG_GRANTED, remoteIP, 'no-token', permission, 'default');
          return next( );
        }
        console.log(LOG_DENIED, remoteIP, 'no-token', permission);
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

      var roles = _.uniq(subject.roles.concat(defaultRoles));

      authorized = {
        token: token
        , sub: subject.name
        // not sending roles to client to prevent us from treating them as magic
        // instead group permissions by role so the we can create correct shiros on the client
        , permissionGroups: _.map(roles, storage.roleToPermissions)
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
