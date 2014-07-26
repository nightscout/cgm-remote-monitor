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
  api.param('alias', function (req, res, next, alias) {
    console.log('alias param', alias);
    settings.alias(alias, function (err, profile) {
      console.log('list');
      req.alias = profile;
      next(err);
    });
  });
  api.get('/settings/', function(req, res) {
    settings.list(function (err, profiles) {
      console.log('list');
      return res.json(profiles);
    });
  });
  // Fetch settings
  api.get('/settings/:alias', function(req, res) {
      /*
      settings.getSettings(function(err, settings) {
          if (err)
              res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
          else
              return res.json(settings);
      });
      */
      res.json(req.alias);
  });

  function config_authed (app, api, wares, settings) {

    // Delete settings
    api.delete('/settings/:alias', wares.verifyAuthorization, function(req, res) {
      settings.remove(req.alias.alias, function ( ) {
        res.json({ });
      });
    });

    api.put('/settings/:alias', wares.verifyAuthorization, function(req, res) {
      // settings.update( );
      res.json(req.query);
    });

    api.post('/settings/:alias', wares.verifyAuthorization, function(req, res) {
      // settings.update( );
      var r = {
        q: req.query
      , b: req.body
      , p: req.params
      , alias: req.alias
      };
      var b = req.body;
      b.alias = req.params.alias
      settings.update(b, function (err, profile) {
        res.json(profile);
      });

      // res.json(r);
    });

    // Replace settings
    api.put('/settings', wares.verifyAuthorization, function(req, res) {
        // Retrieve the JSON formatted record.
        var json = req.body;

        // Send the new settings to mongodb.
        settings.updateSettings(json, function(err, config) {
            if (err)
                res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else {
                // Add a warning to the outgoing status when HTTPS is not being used.
                var warning = '';
                if (req.secure === false)
                    warning = 'WARNING: HTTPS is required to secure your data!';
                
                res.json(config);
            }
        });
    });
  }

  if (app.enabled('api')) {
    config_authed(app, api, wares, settings);
  }

  return api;
}

module.exports = configure;

