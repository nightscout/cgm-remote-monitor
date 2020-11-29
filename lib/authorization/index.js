'use strict';

const _ = require('lodash');
const jwt = require('jsonwebtoken');
const shiroTrie = require('shiro-trie');

const consts = require('./../constants');

const log_green = '\x1B[32m';
const log_red = '\x1b[31m';
const log_reset = '\x1B[0m';
const LOG_GRANTED = log_green + 'GRANTED: ' + log_reset;
const LOG_DENIED = log_red + 'DENIED:  ' + log_reset;

const ipDelayList = {};

const DELAY_ON_FAIL = 5000;
const FAIL_AGE = 60000;

function addFailedRequest (ip) {
  let entry = ipDelayList[ip];
  const now = Date.now();
  if (!entry) {
    ipDelayList[ip] = now + DELAY_ON_FAIL;
    return;
  }
  if (now >= entry) { entry = now; }
  ipDelayList[ip] = entry + DELAY_ON_FAIL;
}

function shouldDelayRequest (ip) {
  let entry = ipDelayList[ip];
  let now = Date.now();
  if (entry) {
    console.log('Delay list entry found', entry);
    if (now < entry) {
      return entry - now;
    }
  }
  return false;
}

function requestSucceeded (ip) {
  if (ipDelayList[ip]) {
    console.log('Clearing delay list entry');
    delete ipDelayList[ip];
  }
}

// Clear items older than a minute

setTimeout(function clearList() {
  for (var key in ipDelayList) {
    if (ipDelayList.hasOwnProperty(key)) {
       if (Date.now() > ipDelayList[key] + FAIL_AGE ) {
         delete ipDelayList[key];
       }
    }
  }
}, 30000);

function getRemoteIP (req) {
  return req.headers['x-forwarded-for'] || req.connection.remoteAddress;
}

function init (env, ctx) {
  var authorization = {};
  var storage = authorization.storage = require('./storage')(env, ctx);
  var defaultRoles = (env.settings.authDefaultRoles || '').split(/[, :]/);

  /**
   * Loads JWT from request
   * 
   * @param {*} req 
   */
  function extractJWTfromRequest (req) {
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

  authorization.extractToken = extractJWTfromRequest;

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

  /**
   * Fetches the API_SECRET from the request
   * 
   * @param {*} req Express request object
   */
  function APISecretFromRequest (req) {
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

  function authorizeAdminSecret (secret) {
    return (env.api_secret && env.api_secret.length > 12) ? (secret === env.api_secret) : false;
  }

  authorization.seenPermissions = [];

  authorization.expandedPermissions = function expandedPermissions () {
    var permissions = shiroTrie.new();
    permissions.add(authorization.seenPermissions);
    return permissions;
  };

  authorization.resolveWithRequest = function resolveWithRequest (req, callback) {
    authorization.resolve({
      api_secret: APISecretFromRequest(req)
      , token: extractJWTfromRequest(req)
      , ip: getRemoteIP(req)
    }, callback);
  }

  authorization.checkMultiple = function checkMultiple (permission, shiros) {
    var found = _.find(shiros, function checkEach (shiro) {
      return shiro && shiro.check(permission);
    });
    return _.isObject(found);
  };

  authorization.resolve = function resolve (data, callback) {

    if (!data.ip) {
      console.error('Trying to authorize without IP information');
      return callback(null, { shiros: [] });
    }

    function check (data, callback) {

      console.log('Authorization resolving auth', data);

      var defaultShiros = storage.rolesToShiros(defaultRoles);

      if (data.api_secret && data.api_secret !== null && data.api_secret !== 'null') {
        console.log('Tying to authorize secret/token', data.api_secret);
        if (storage.doesAccessTokenExist(data.api_secret)) {
          authorization.resolveAccessToken(data.api_secret, callback, defaultShiros);
          return;
        } else {
          console.log('Token/secret not found, adding to delay list');
          addFailedRequest(data.ip);
        }
      }

      console.log('Resolving auth 2');

      if (authorizeAdminSecret(data.api_secret)) {
        var admin = shiroTrie.new();
        admin.add(['*']);
        return callback(null, { shiros: [admin] });
      }

      console.log('Resolving auth 3');

      if (data.token) {
        console.log('Token', data.token);
        jwt.verify(data.token, env.api_secret, function result (err, verified) {
          if (err) {
            return callback(err, { shiros: [] });
          } else {
            authorization.resolveAccessToken(verified.accessToken, callback, defaultShiros);
          }
        });
      } else {
        console.log('Granting default permissions', JSON.stringify(defaultShiros));
        return callback(null, { shiros: defaultShiros });
      }

      console.log('Resolved to end?');
    }

    // data, callback, ip

    const requestDelay = shouldDelayRequest(data.ip);

    if (requestDelay) {
      console.log('Concurrent or failed requests, delaying request by', requestDelay);
      setTimeout(() => { check(data, callback); }, requestDelay);
    } else {
      console.log('Checking permissions without delay');
      check(data, callback);
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

  /**
   * Check if the client has a permission execute an action,
   * based on an API_SECRET or JWT in the request.
   * 
   * Used to authorize API calls
   * 
   * @param {*} permission Permission being checked
   */
  authorization.isPermitted = function isPermitted (permission) {

    authorization.seenPermissions = _.chain(authorization.seenPermissions)
      .push(permission)
      .sort()
      .uniq()
      .value();

    function check (req, res, next) {

      var remoteIP = getRemoteIP(req);

      // Check if the token in the request is the API_SECRET

      var secret = APISecretFromRequest(req);

      if (authorizeAdminSecret(secret)) {
        console.log(LOG_GRANTED, remoteIP, 'api-secret', permission);
        requestSucceeded(remoteIP);
        next();
        return;
      }

      var defaultShiros = storage.rolesToShiros(defaultRoles);

      if (storage.doesAccessTokenExist(secret)) {
        var resolved = storage.resolveSubjectAndPermissions(secret);

        if (authorization.checkMultiple(permission, resolved.shiros)) {
          console.log(LOG_GRANTED, remoteIP, resolved.accessToken, permission);
          requestSucceeded(remoteIP);
          next();
        } else if (authorization.checkMultiple(permission, defaultShiros)) {
          console.log(LOG_GRANTED, remoteIP, resolved.accessToken, permission, 'default');
          requestSucceeded(remoteIP);
          next();
        } else {
          console.log(LOG_DENIED, remoteIP, resolved.accessToken, permission);
          addFailedRequest(remoteIP);
          res.sendJSONStatus(res, consts.HTTP_UNAUTHORIZED, 'Unauthorized', 'Invalid/Missing');
        }
        return;
      }

      var token = extractJWTfromRequest(req);

      if (token) {
        console.log('Checking permissions based on a JWT token');
        jwt.verify(token, env.api_secret, function result (err, verified) {
          if (err) {
            console.info('Error verifying Authorized Token', err);
            res.status(consts.HTTP_UNAUTHORIZED).send('Unauthorized - Invalid/Missing');
          } else {
            var resolved = storage.resolveSubjectAndPermissions(verified.accessToken);
            if (authorization.checkMultiple(permission, resolved.shiros)) {
              console.log(LOG_GRANTED, remoteIP, verified.accessToken, permission);
              requestSucceeded(remoteIP);
              next();
            } else if (authorization.checkMultiple(permission, defaultShiros)) {
              console.log(LOG_GRANTED, remoteIP, verified.accessToken, permission, 'default');
              requestSucceeded(remoteIP);
              next();
            } else {
              console.log(LOG_DENIED, remoteIP, verified.accessToken, permission);
              addFailedRequest(remoteIP);
              res.sendJSONStatus(res, consts.HTTP_UNAUTHORIZED, 'Unauthorized', 'Invalid/Missing');
            }
          }
        });
      } else {
        if (authorization.checkMultiple(permission, defaultShiros)) {
          console.log(LOG_GRANTED, remoteIP, 'no-token', permission, 'default');
          requestSucceeded(remoteIP);
          return next();
        }
        console.log(LOG_DENIED, remoteIP, 'no-token', permission);
        addFailedRequest(remoteIP);
        res.sendJSONStatus(res, consts.HTTP_UNAUTHORIZED, 'Unauthorized', 'Invalid/Missing');
      }

    }

    const boundCheck = checkWithDelay.bind({ callback: check });

    return boundCheck;
  };

  /**
   * Adds a delay mechanism to checking API_SECRET or token from a request
   * 
   * @param {*} req 
   * @param {*} p1 
   * @param {*} p2 
   */
  function checkWithDelay (req, p1, p2) {

    console.log('Checking permissions');

    var remoteIP = getRemoteIP(req);
    const requestDelay = shouldDelayRequest(remoteIP);

    if (requestDelay) {
      console.log('Concurrent or failed requests, delaying request by', requestDelay);
      setTimeout(() => { this.callback(req, p1, p2); }, requestDelay);
    } else {
      console.log('Checking permissions without delay');
      this.callback(req, p1, p2);
    }
  }

  /**
   * Generates a JWT based on an access token or an API_SECRET
   * 
   * @param {*} accessToken API_SECRET or Token to be used for generating a JWT for the client
   */
  authorization.authorize = function authorize (accessToken) {

    console.log('Authorize call');

    var subject = storage.findSubject(accessToken);

    var authorized = null;

    if (subject) {
      var token = jwt.sign({ accessToken: subject.accessToken }, env.api_secret, { expiresIn: '1h' });

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

      console.log('authorized', authorized);
    }

    return authorized;
  };

  authorization.endpoints = require('./endpoints')(env, authorization);

  return authorization;
}

module.exports = init;
