'use strict';

function configure (app, ctx, env, authBuilder) {
  var express = require('express')
    , api = express.Router( )
    , apiConst = require('../const.json')
    , storageTools = require('../shared/storageTools')(app)
    ;

  api.get('/status', function getVersion (req, res) {

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


    authBuilder.authorizerFor()(req, res, async function authorized () {

      try {
        const cols = app.get('collections');

        let info = await storageTools.getVersionInfo();

        info.apiPermissions = {};
        for (let col in cols) {
          var colPerms = permsForCol(col);
          if (colPerms) {
            info.apiPermissions[col] = colPerms;
          }
        }

        res.json(info);

      } catch (err) {
        console.error(err);
        return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    });

  });

  return api;
}
module.exports = configure;
