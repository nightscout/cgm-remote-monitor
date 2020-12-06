'use strict';

var consts = require('../constants');

function configure (ctx) {
  var express = require('express'),
      api = express.Router( );

  api.get('/adminnotifies', function(req, res) {
    ctx.authorization.resolveWithRequest(req, function resolved (err, result) {

      const isAdmin = ctx.authorization.checkMultiple('*:*:admin', result.shiros); //full admin permissions

      let response = {
        notifies: []
        , notifyCount: 0
      };

      if (ctx.adminnotifies) {
        const notifies = ctx.adminnotifies.getNotifies();
        if (isAdmin) { response.notifies = notifies}
        response.notifyCount = notifies.length;
      }

      res.sendJSONStatus(res, consts.HTTP_OK, response);
    });
  });

  return api;
}

module.exports = configure;
