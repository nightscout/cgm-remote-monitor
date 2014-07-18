'use strict';

var consts = require('./constants');

/*
 * API - Expose Nightscout HTTP API
 * This implementation is designed to work with express.
 */

function create (env, entries, settings) {
  var express = require('express'),
      app = express( );

  var wares = require('./middleware/')(env);
  app.disable('api');
  if (env.api_secret) {
    console.log("API_SECRET", env.api_secret);
    app.enable('api');
  }
  // set up express basics
  app.set('title', 'Nightscout API v1');
  return configure.call(app, wares, entries, settings);
}

function configure (wares, entries, settings) {

    // our globals
    var express = require('express'),
        // app = express( ),
        app = this,
        api = express.Router( )
    ;

    // some middleware
    var verifyAuthorization = wares.verifyAuthorization,
        sendJSONStatus = wares.sendJSONStatus,
        bodyParser = require('body-parser')
        ;

    // invoke common middleware
    api.use(sendJSONStatus);
    // text body types get handled as raw buffer stream
    api.use(bodyParser.raw());
    // json body types get handled as parsed json
    api.use(bodyParser.json());
    // shortcut to use extension to specify output content-type
    api.use(require('express-extension-to-accept')([
      'json', 'svg', 'csv', 'txt', 'png', 'html', 'tsv'
    ]));
    var common = [
      sendJSONStatus,
      bodyParser.raw(),
      bodyParser.json(),
      require('express-extension-to-accept')([
        'json', 'svg', 'csv', 'txt', 'png', 'html', 'tsv'
      ]),
      bodyParser.urlencoded({ extended: true })
    ];
    wares.common = common;

    // also support url-encoded content-type
    api.use(bodyParser.urlencoded({ extended: true }));

    /*
     * Start setting up routes
     */

    // Some experiments
    // app.use('/authorized', require('./api/experiments/')(app, wares));
    api.get('/authorized/:secret/test', wares.verifyAuthorization, function (req, res, next) {
        return res.json({status: 'ok'});
    });

    api.get('/authorized/test', wares.verifyAuthorization, function (req, res, next) {
        return res.json({status: 'ok'});
    });

    // Status badge/text/json
    api.get('/status', function (req, res, next) {
        var status = {status: 'ok'};
        var badge = 'http://img.shields.io/badge/Nightscout-OK-green';
        return res.format({
          html: function ( ) {
            res.send("<h1>STATUS OK</h1>");
          },
          png: function ( ) {
            res.redirect(302, badge + '.png');
          },
          svg: function ( ) {
            res.redirect(302, badge + '.svg');
          },
          text: function ( ) {
            res.send("STATUS OK");
          },
          json: function ( ) {
            res.json(status);
          }
        });
    });

    /**********\
     * Entries
    \**********/
    app.use('/entries', require('./api/entries/')(app, wares, entries));

    /**********\
     * Settings
    \**********/
    // app.use('/settings', require('./api/settings/')(app, wares, settings));

    // Fetch settings
    api.get('/settings', function(req, res) {
        settings.getSettings(function(err, settings) {
            if (err)
                res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', err);
            else
                return res.json(settings);
        });
    });

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

    app.use(api);

    return app;
}

create.configure = configure;
module.exports = create;

