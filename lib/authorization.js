'use strict';

var _ = require('lodash');
var express = require('express');
var crypto = require('crypto');
var jwt = require('jsonwebtoken');
var shiroTrie = require('shiro-trie');

var consts = require('./constants');

function create (env, ctx) {
  var endpoints = express( );

  var wares = require('./middleware/index')(env);

  endpoints.use(wares.sendJSONStatus);
  // text body types get handled as raw buffer stream
  endpoints.use(wares.bodyParser.raw());
  // json body types get handled as parsed json
  endpoints.use(wares.bodyParser.json());
  // also support url-encoded content-type
  endpoints.use(wares.bodyParser.urlencoded({ extended: true }));

  //TODO: load from mongo
  var roles = [
    {name: 'admin', permissions: ['*']}
    , {name: 'careportal', permissions: ['api:treatments:create', 'alarms:default:ack']}
  ];

  var subjects = _.map([
    {_id: '579cf4ad65110bbfc193acc3', name: 'Dad Mac', roles: ['admin']}
    , {_id: '579cf4ad65410bbfc193acc3', name: 'Dad Phone', roles: ['admin']}
    , {_id: '579cf48d65110bbfc193acc3', name: 'Dad Tablet', roles: ['admin']}
    , {_id: '579cef9265110bbfc193acbd', name: 'Mom Mac', roles: ['admin']}
    , {_id: '579cef9265110bbfc193abad', name: 'Mom Phone', roles: ['admin']}
    , {_id: '579ce3dd65110bbfc193acaf', name: 'Health Office', roles: ['careportal']}
  ], function eachSubject (subject) {

    if (env.api_secret) {
      var shasum = crypto.createHash('sha1');
      shasum.update(env.api_secret);
      shasum.update(subject._id);
      var digest = shasum.digest('base64').substring(0, 10);
      var abbrev = subject.name.toLowerCase().replace(/[\W]/g, '').substring(0, 10);
      subject.digest = digest;
      subject.accessToken = abbrev + '-' + digest;
    }

    return subject;
  });

  function rolesToPermissions (roleNames) {
    var permissions = [ ];

    _.forEach(roleNames, function eachRoleName (roleName) {
      var role = _.find(roles, {name: roleName});
      if (role) {
        permissions = permissions.concat(role.permissions);
      }
    });

    return _.uniq(permissions);
  }

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

  function findSubject(accessToken) {
    var prefix = _.last(accessToken.split('-'));

    if (prefix.length < 8) {
      return null;
    }

    return _.find(subjects, function matches (subject) {
      return subject.digest.indexOf(prefix) === 0;
    });
  }

  function isPermitted (permission) {

    function check(req, res, next) {

      if (authorizeAdminSecret(req)) {
        next( );
        return;
      }

      var token = extractToken(req);

      if (token) {
        jwt.verify(token, env.api_secret, function result(err, verified) {
          if (err) {
            console.info('Error verifiing Authorized Token', err);
            res.status(consts.HTTP_UNAUTHORIZED).send('Unauthorized - Invalid/Missing');
          } else {
            console.info('Verified Authorization', verified);
            var permissions = shiroTrie.new();
            var subject = findSubject(verified.accessToken);
            if (subject) {
              console.info('Found Subject', subject);
              permissions.add(rolesToPermissions(subject.roles));
            }
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
  }

  function authorize (accessToken) {
    var subject = findSubject(accessToken);

    var authorized = null;

    if (subject) {
      var token = jwt.sign( { accessToken: subject.accessToken }, env.api_secret, { expiresIn: '1h' } );

      //decode so we can tell the client the issued and expired times
      var decoded = jwt.decode(token);

      authorized = {
        token: token
        , sub: subject.name
        , permissions: rolesToPermissions(subject.roles)
        , iat: decoded.iat
        , exp: decoded.exp
      };
    }

    return authorized;
  }

  endpoints.get('/subjects', isPermitted('authorization:subjects:read'), function getTokens (req, res) {
    res.json(_.map(subjects, function eachSubject (subject) {
      return _.pick(subject, ['_id', 'name', 'accessToken', 'roles']);
    }));
  });

  endpoints.get('/roles', isPermitted('authorization:roles:list'), function getRoles (req, res) {
    res.json(roles);
  });

  endpoints.get('/request/:accessToken', function requestAuthorize (req, res) {
    var authorized = authorize(req.params.accessToken);

    if (authorized) {
      res.json(authorized);
    } else {
      res.sendJSONStatus(res, consts.HTTP_UNAUTHORIZED, 'Unauthorized', 'Invalid/Missing');
    }
  });

  endpoints.get('/debug/check/:permission', function check (req, res, next) {
    isPermitted(req.params.permission)(req, res, next);
  }, function debug (req, res) {
    res.json({check: true});
  });

  return {
    isPermitted: isPermitted
    , authorize: authorize
    , endpoints: endpoints
  };
}

module.exports = create;