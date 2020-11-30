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

const sleep = require('util').promisify(setTimeout);

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
    if (now < entry) {
      return entry - now;
    }
  }
  return false;
}

function requestSucceeded (ip) {
  if (ipDelayList[ip]) {
    delete ipDelayList[ip];
  }
}

// Clear items older than a minute

setTimeout(function clearList () {
  for (var key in ipDelayList) {
    if (ipDelayList.hasOwnProperty(key)) {
      if (Date.now() > ipDelayList[key] + FAIL_AGE) {
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

  /**
   * Check if the Apache Shiro-style permission object includes the permission.
   * 
   * Returns a boolean true / false depending on if the permission is found.
   * 
   * @param {*} permission Desired permission
   * @param {*} shiros Shiros
   */

  authorization.checkMultiple = function checkMultiple (permission, shiros) {
    var found = _.find(shiros, function checkEach (shiro) {
      return shiro && shiro.check(permission);
    });
    return _.isObject(found);
  };

  /**
   * Resolve an API secret or token and return the permissions associated with
   * the secret / token
   * 
   * @param {*} data 
   * @param {*} callback 
   */
  authorization.resolve = async function resolve (data, callback) {

    if (!data.ip) {
      console.error('Trying to authorize without IP information');
      return callback(null, { shiros: [] });
    }

    data.api_secret = data.api_secret || null;

    if (data.api_secret == 'null') { // TODO find what's sending this anomaly
      data.api_secret = null;
    }

    async function check (data, callback) {

      const requestDelay = shouldDelayRequest(data.ip);

      if (requestDelay) {
        await sleep(requestDelay);
      }

      const authAttempted = (data.api_secret || data.token) ? true : false;
      const defaultShiros = storage.rolesToShiros(defaultRoles);

      // If there is no token or secret, return default permissions
      if (!authAttempted) {
        const result = { shiros: defaultShiros };
        if (callback) { callback(null, result); }
        return result;
      }

      // Check for API_SECRET first as that allows bailing out fast

      if (data.api_secret && authorizeAdminSecret(data.api_secret)) {
        requestSucceeded(data.ip);
        var admin = shiroTrie.new();
        admin.add(['*']);
        const result = { shiros: [admin] };
        if (callback) { callback(null, result); }
        return result;
      }

      // If we reach this point, we must be dealing with a role based token

      let token = null;

      // Tokens have to be well formed JWTs
      try {
        const verified = await jwt.verify(data.token, env.api_secret);
        token = verified.accessToken;
      } catch (err) {}

      // Check if there's a token in the secret

      if (!token && data.api_secret) {
        if (storage.doesAccessTokenExist(data.api_secret)) {
          token = data.api_secret;
        }
      }

      if (token) {
        requestSucceeded(data.ip);
        const results = authorization.resolveAccessToken(token, null, defaultShiros);
        if (callback) { callback(null, results); }
        return results;
      }

      console.error('Resolving secret/token to permissions failed');
      addFailedRequest(data.ip);
      callback('All validation failed', {});
      return {};
    }

    return check(data, callback);
  };

  authorization.resolveAccessToken = function resolveAccessToken (accessToken, callback, defaultShiros) {

    if (!defaultShiros) {
      defaultShiros = storage.rolesToShiros(defaultRoles);
    }

    let resolved = storage.resolveSubjectAndPermissions(accessToken);
    if (!resolved || !resolved.subject) {
      if (callback) { callback('Subject not found', null); }
      return null;
    }

    let shiros = resolved.shiros.concat(defaultShiros);
    const result = { shiros: shiros, subject: resolved.subject };
    if (callback) { callback(null, result); }
    return result;
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

    async function check (req, res, next) {

      var remoteIP = getRemoteIP(req);
      var secret = APISecretFromRequest(req);
      var token = extractJWTfromRequest(req);

      const data = { api_secret: secret, token: token, ip: remoteIP };

      const permissions = await authorization.resolve(data);
      const permitted = authorization.checkMultiple(permission, permissions.shiros);

      if (permitted) {
        next();
        return;
      }

      res.sendJSONStatus(res, consts.HTTP_UNAUTHORIZED, 'Unauthorized', 'Invalid/Missing');
    }

    return check;

  };

  /**
   * Generates a JWT based on an access token
   * 
   * @param {*} accessToken token to be used for generating a JWT for the client
   */
  authorization.authorize = function authorize (accessToken) {

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
