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
  // Fetch settings
  api.get('/settings', function(req, res) {
      settings.getSettings(function(err, settings) {
          if (err)
              res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
          else
              return res.json(settings);
      });
  });

  function config_authed (app, api, wares, settings) {

    // Delete settings
    api.delete('/settings', wares.verifyAuthorization, function(req, res) {
      settings.remove(function ( ) {
        res.json({ });
      });
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

