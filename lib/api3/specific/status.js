'use strict';

function configure (app, ctx, env, authBuilder) {
  var express = require('express'),
    api = express.Router( ),
    _ = require('lodash')

  api.get('/status', function getVersion (req, res) {
    var date = new Date();
    var info = { version: app.get('version')
      , apiVersion: app.get('apiVersion')
      , srvDate: date.getTime()
      , srvDateString: date.toISOString()
    };


    authBuilder.authorizerFor()(req, res, function authorized () {

      var cols = app.get('collections')
        , wasError = false;

      info.apiPermissions = {};
      _.each(cols, function rightsForCol (col) {
        var colPerms = '';

        if (authBuilder.checkPermission(req, 'api:' + col.colName + ':create')) {
            colPerms += 'c';
        }

        if (authBuilder.checkPermission(req, 'api:' + col.colName + ':read')) {
            colPerms += 'r';
        }

        if (authBuilder.checkPermission(req, 'api:' + col.colName + ':update')) {
            colPerms += 'u';
        }

        if (authBuilder.checkPermission(req, 'api:' + col.colName + ':delete')) {
            colPerms += 'd';
        }

        if (colPerms) {
          info.apiPermissions[col.colName] = colPerms;
        }
      });

      res.json(info);
    });

  });

  return api;
}
module.exports = configure;
