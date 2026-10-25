'use strict';

function configure (app, wares, env, ctx) {
  var express = require('express'),
    getRemoteIP = require('../server/client-ip').clientIPFor(env),
    api = express.Router( )
    ;

  api.use(wares.sendJSONStatus);
  api.use(wares.extensions([
    'json', 'svg', 'csv', 'txt', 'png', 'html', 'js'
  ]));

  // Status can issue a session token. Cover refusals as well as successes.
  api.use(function statusCache (req, res, next) {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(ctx.authorization.isPermitted('api:status:read'));

  // Status badge/text/json
  api.get('/status', function (req, res) {
    
    let extended = env.settings.filteredSettings(app.extendedClientSettings);
    let settings = env.settings.filteredSettings(env.settings);

    // Use the same bearer extraction as the permission middleware. Retain
    // query credentials for existing API clients and shared links.
    var authToken = ctx.authorization.extractToken(req) || req.header('api-secret') || req.query.secret || '';

    var date = new Date();
    var info = { status: 'ok'
      , name: app.get('name')
      , version: app.get('version')
      , serverTime: date.toISOString()
      , serverTimeEpoch: date.getTime()
      , apiEnabled: app.enabled('api')
      , careportalEnabled: app.enabled('api') && env.settings.enable.indexOf('careportal') > -1
      , boluscalcEnabled: app.enabled('api') && env.settings.enable.indexOf('boluscalc') > -1
      , settings: settings
      , extendedSettings: extended
      , authorized: ctx.authorization.authorize(authToken, getRemoteIP(req))
      , runtimeState: ctx.runtimeState
    };

    var badge = 'http://img.shields.io/badge/Nightscout-OK-green';
    return res.format({
      html: function ( ) {
        res.send('<h1>STATUS OK</h1>');
      },
      png: function ( ) {
        res.redirect(302, badge + '.png');
      },
      svg: function ( ) {
        res.redirect(302, badge + '.svg');
      },
      js: function ( ) {
        var parts = ['this.serverSettings =', JSON.stringify(info), ';'];

        res.send(parts.join(' '));
      },
      text: function ( ) {
        res.send('STATUS OK');
      },
      json: function ( ) {
        res.json(info);
      }
    });
  });

  return api;
}
module.exports = configure;
