'use strict';

function configure (app) {
  var express = require('express'),
    api = express.Router( )

  api.get('/version', function getVersion (req, res) {
    var date = new Date();
    var info = { version: app.get('version')
      , apiVersion: app.get('apiVersion')
      , srvDate: date.getTime()
      , srvDateString: date.toISOString()
    };

    res.json(info);
  });

  return api;
}
module.exports = configure;
