'use strict';

function configure (app, ctx, env, authBuilder) {
  var express = require('express'),
    api = express.Router( ),
    _ = require('lodash')

  api.get('/status', function getVersion (req, res) {
    var info = { version: app.get('version')
      , apiVersion: app.get('apiVersion')
    };


    function permsForCol (col) {
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

      return colPerms;
    }


    authBuilder.authorizerFor()(req, res, function authorized () {

      var cols = app.get('collections')
        , storage = cols.entries.storage;

      storage.status(function storageStatusDone (err, result) {
        if (err || !result) {
          console.error(err);
          return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
        }

        info.storage = { 
          type: result.storage,
          version: result.version,
          srvDate: result.srvDate.getTime(),
          srvDateString: result.srvDate.toISOString()
        };

        info.apiPermissions = {};
        _.each(cols, function eachCol (col) {
          var colPerms = permsForCol (col);
          if (colPerms) {
            info.apiPermissions[col.colName] = colPerms;
          }
        });

        res.json(info);
      });
    });

  });

  return api;
}
module.exports = configure;
