'use strict';

function configure (app, wares, env) {
  var express = require('express'),
    api = express.Router( )
    ;

  api.use(wares.extensions([
    'json', 'svg', 'csv', 'txt', 'png', 'html', 'js'
  ]));
  // Status badge/text/json
  api.get('/status', function (req, res) {
    var info = { status: 'ok'
      , name: app.get('name')
      , version: app.get('version')
      , serverTime: new Date().toISOString()
      , apiEnabled: app.enabled('api')
      , careportalEnabled: app.enabled('api') && env.settings.enable.indexOf('careportal') > -1
      , boluscalcEnabled: app.enabled('api') && env.settings.enable.indexOf('boluscalc') > -1
      , head: wares.get_head( )
      , settings: env.settings
      , extendedSettings: app.extendedClientSettings
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
        var head = 'this.serverSettings =';
        var body = JSON.stringify(info);
        var tail = ';';
        res.send([head, body, tail].join(' '));
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
