'use strict';

function configure (app, ctx, env) {
  const express = require('express')
    , api = express.Router( )
    , apiConst = require('../const.json')
    , storageTools = require('../shared/storageTools')
    , security = require('../security')
    , opTools = require('../shared/operationTools')
    ;

  api.get('/status', async function getStatus (req, res) {

    function permsForCol (col, auth) {
      let colPerms = '';

      if (security.checkPermission(auth, 'api:' + col.colName + ':create')) {
          colPerms += 'c';
      }

      if (security.checkPermission(auth, 'api:' + col.colName + ':read')) {
          colPerms += 'r';
      }

      if (security.checkPermission(auth, 'api:' + col.colName + ':update')) {
          colPerms += 'u';
      }

      if (security.checkPermission(auth, 'api:' + col.colName + ':delete')) {
          colPerms += 'd';
      }

      return colPerms;
    }


    async function operation (opCtx) {
      const cols = app.get('collections');

      let info = await storageTools.getVersionInfo(app);

      info.apiPermissions = {};
      for (let col in cols) {
        const colPerms = permsForCol(col, opCtx.auth);
        if (colPerms) {
          info.apiPermissions[col] = colPerms;
        }
      }

      opTools.sendJSON({ res, result: info });
    }


    const opCtx = { app, ctx, env, req, res };

    try {
      opCtx.auth = await security.authenticate(opCtx);

      await operation(opCtx);

    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        return opTools.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }
  });

  return api;
}
module.exports = configure;
