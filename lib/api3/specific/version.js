'use strict';

function configure (app) {
  var express = require('express')
    , api = express.Router( )
    , apiConst = require('../const.json')
    ;

  api.get('/version', function getVersion (req, res) {
    var info = { version: app.get('version')
      , apiVersion: app.get('apiVersion')
    };

    var storage = app.get('collections').entries.storage;

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

      res.json(info);
    });  
  });

  return api;
}
module.exports = configure;
