'use strict';

function configure (app, ctx, env, authBuilder) {
  var express = require('express'),
    api = express.Router( )

  api.get('/history', function getHistory (req, res) {
    var date = new Date();
    var info = { srvDate: date.getTime()
      , srvDateString: date.toISOString()
    };

    authBuilder.authorizerFor()(req, res, function authorized () {
      var treatments = authBuilder.checkPermission(req, 'api:treatments:read');
      var entries = authBuilder.checkPermission(req, 'api:entries:read');
      res.json(info);
    });
  });

  return api;
}
module.exports = configure;
