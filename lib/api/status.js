'use strict';

function configure (app, wares) {
  var express = require('express'),
      api = express.Router( )
  ;

  api.use(wares.extensions([
    'json', 'svg', 'csv', 'txt', 'png', 'html', 'js'
  ]));
  // Status badge/text/json
  api.get('/status', function (req, res, next) {
      var info = { status: 'ok'
          , apiEnabled: app.enabled('api')
          , careportalEnabled: app.enabled('api') && app.enabled('careportal')
          , units: app.get('units')
          , head: wares.get_head( )
          , version: app.get('version')
          , thresholds: app.thresholds
          , alarm_types: app.alarm_types
          , name: app.get('name')};
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
        js: function ( ) {
          var head = "this.serverSettings =";
          var body = JSON.stringify(info);
          var tail = ';';
          res.send([head, body, tail].join(' '));
        },
        text: function ( ) {
          res.send("STATUS OK");
        },
        json: function ( ) {
          res.json(info);
        }
      });
  });

  return api;
}
module.exports = configure;
