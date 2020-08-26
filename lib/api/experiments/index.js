'use strict';

function configure (app, wares, ctx) {
  var express = require('express'),
      api = express.Router( )
  ;

  if (app.enabled('api')) {
    api.use(wares.sendJSONStatus);

    api.get('/test', ctx.authorization.isPermitted('authorization:debug:test'), function (req, res) {
        return res.json({status: 'ok'});
    });
  }

  return api;
}

module.exports = configure;
