'use strict';

var consts = require('../../constants');

function configure (app, wares, settings) {
  var express = require('express'),
      api = express.Router( )
  ;
  // invoke common middleware
  api.use(wares.sendJSONStatus);
  // text body types get handled as raw buffer stream
  api.use(wares.bodyParser.raw( ));
  // json body types get handled as parsed json
  api.use(wares.bodyParser.json( ));
  // also support url-encoded content-type
  api.use(wares.bodyParser.urlencoded({ extended: true }));


  /**********\
   * Settings
  \**********/
  // Handler for grabbing alias/profile
  api.param('alias', function (req, res, next, alias) {
    settings.alias(alias, function (err, profile) {
      req.alias = profile;
      next(err);
    });
  });

  // List settings available
  api.get('/settings/', function(req, res) {
    settings.list(function (err, profiles) {
      return res.json(profiles);
    });
  });

  // Fetch settings
  api.get('/settings/:alias', function(req, res) {
      res.json(req.alias);
  });

  function config_authed (app, api, wares, settings) {

    // Delete settings
    api.delete('/settings/:alias', wares.verifyAuthorization, function(req, res) {
      settings.remove(req.alias.alias, function ( ) {
        res.json({ });
      });
    });

    function save_settings (req, res) {
      var b = req.body;
      b.alias = req.params.alias
      settings.update(b, function (err, profile) {
        res.json(profile);
      });
    }

    // Update settings
    api.put('/settings/:alias', wares.verifyAuthorization, save_settings);
    api.post('/settings/:alias', wares.verifyAuthorization, save_settings);

  }

  if (app.enabled('api')) {
    config_authed(app, api, wares, settings);
  }

  return api;
}

module.exports = configure;

