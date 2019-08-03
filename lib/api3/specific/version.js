'use strict';

function configure (app) {
  var express = require('express')
    , api = express.Router( )
    , apiConst = require('../const.json')
    , storageTools = require('../shared/storageTools')(app)
    , opTools = require('../shared/operationTools')
    ;

  api.get('/version', function getVersion (req, res) {

    storageTools.getVersionInfo()

    .then(function resolved (result) {
      res.json(result);
    })

    .catch(function rejected (err) {
      console.error(err);
      if (!res.headersSent) {
        return opTools.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    })
  });

  return api;
}
module.exports = configure;
