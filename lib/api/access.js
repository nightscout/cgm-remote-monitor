'use strict';

var _ = require('lodash');
var express = require('express');
var crypto = require('crypto');
var jwt = require('jsonwebtoken');

var consts = require('../constants');

function create (env, ctx) {
  var endpoints = express( );

  var wares = require('../middleware/')(env);

  endpoints.use(wares.sendJSONStatus);
  // text body types get handled as raw buffer stream
  endpoints.use(wares.bodyParser.raw());
  // json body types get handled as parsed json
  endpoints.use(wares.bodyParser.json());
  // also support url-encoded content-type
  endpoints.use(wares.bodyParser.urlencoded({ extended: true }));


  //TODO: load from mongo
  var tokens = _.map([
    {_id: '579cf4ad65110bbfc193acc3', name: 'Dad', roles: ['admin']}
    , {_id: '579cef9265110bbfc193acbd', name: 'Mom', roles: ['admin']}
    , {_id: '579ce3dd65110bbfc193acaf', name: 'Health Office', roles: ['careportal']}
  ], function eachToken(token) {

    if (env.api_secret) {
      var shasum = crypto.createHash('sha1');
      shasum.update(env.api_secret);
      shasum.update(token._id);
      token.key = shasum.digest('hex');
    }

    delete token._id;

    return token;
  });

  var roles = [
    {name: 'admin', activities: ['*:*']}
    , {name: 'careportal', activities: ['treatments:post']}
  ];

  endpoints.get('/tokens', wares.verifyAuthorization, function getTokens (req, res) {
    res.json(tokens);
  });

  endpoints.get('/roles', wares.verifyAuthorization, function getRoles (req, res) {
    res.json(roles);
  });

  endpoints.post('/authorize', function authorize (req, res) {
    var key = req.body && req.body.key;

    var token = _.find(tokens, {key: key});

    if (token) {
      var authorized = jwt.sign({ name: token.name, roles: token.roles }, env.api_secret);
      res.send(authorized);
    } else {
      res.status(consts.HTTP_UNAUTHORIZED).send('Unauthorized - Invalid/Missing');
    }
  });

  endpoints.post('/verify', function authorize (req, res) {
    var authorized = req.body && req.body.authorized;

    if (authorized) {
      jwt.verify(authorized, env.api_secret, function result (err, verified) {
        if (err) {
          console.info('Error verifiing Authorized Token', err);
          res.status(consts.HTTP_UNAUTHORIZED).send('Unauthorized - Invalid/Missing');
        } else {
          console.info('Verified Authorized Token', verified);
          res.send(true);
        }
      });
    } else {
      res.status(consts.HTTP_UNAUTHORIZED).send('Unauthorized - Invalid/Missing');
    }

  });


  return {
    endpoints: endpoints
  };
}

module.exports = create;