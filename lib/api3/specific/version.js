'use strict';

function configure (app) {
  const express = require('express')
    , api = express.Router( )
    , apiConst = require('../const.json')
    , storageTools = require('../shared/storageTools')
    , opTools = require('../shared/operationTools')
    ;

  api.get('/version', async function getVersion (req, res) {

    try {
      const versionInfo = await storageTools.getVersionInfo(app);

      opTools.sendJSON({ res, result: versionInfo });

    } catch(error) {
      console.error(error);
      if (!res.headersSent) {
        return opTools.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }
  });

  return api;
}
module.exports = configure;
