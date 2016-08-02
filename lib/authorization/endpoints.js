'use strict';

var _ = require('lodash');
var express = require('express');

var consts = require('./../constants');

function init (env, authorization) {
  var endpoints = express( );

  var wares = require('./../middleware/index')(env);

  endpoints.use(wares.sendJSONStatus);
  // text body types get handled as raw buffer stream
  endpoints.use(wares.bodyParser.raw());
  // json body types get handled as parsed json
  endpoints.use(wares.bodyParser.json());
  // also support url-encoded content-type
  endpoints.use(wares.bodyParser.urlencoded({ extended: true }));

  endpoints.get('/subjects', authorization.isPermitted('authorization:subjects:read'), function getSubjects (req, res) {
    res.json(_.map(authorization.storage.subjects, function eachSubject (subject) {
      return _.pick(subject, ['_id', 'name', 'accessToken', 'roles']);
    }));
  });

  endpoints.post('/subjects', authorization.isPermitted('authorization:subjects:create'), function createSubjectt (req, res) {
    authorization.storage.createSubject(req.body, function created (err, created) {
      if (err) {
        res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
      } else {
        res.json(created);
      }
    })
  });

  endpoints.get('/roles', authorization.isPermitted('authorization:roles:list'), function getRoles (req, res) {
    res.json(authorization.storage.roles);
  });

  endpoints.get('/request/:accessToken', function requestAuthorize (req, res) {
    var authorized = authorization.authorize(req.params.accessToken);

    if (authorized) {
      res.json(authorized);
    } else {
      res.sendJSONStatus(res, consts.HTTP_UNAUTHORIZED, 'Unauthorized', 'Invalid/Missing');
    }
  });

  endpoints.get('/debug/check/:permission', function check (req, res, next) {
    authorization.isPermitted(req.params.permission)(req, res, next);
  }, function debug (req, res) {
    res.json({check: true});
  });


  return endpoints;
}

module.exports = init;
