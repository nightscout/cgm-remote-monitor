'use strict';

function configure (app) {
  var express = require('express')
    , api = express.Router( )
    , apiConst = require('../const.json')
    , storageTools = require('../shared/storageTools')(app)
    ;

  api.get('/version', function getVersion (req, res) {
    var info = { version: app.get('version')
      , apiVersion: app.get('apiVersion')
    }
      , storage = app.get('entriesCollection').storage
      ;

    storage.currentDate(function currentDateDone (err, result) {
      if (err || !result) {
        console.error(err);
        return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }

      storageTools.getStorageVersion(function getVersionDone (err, storageVersion) {
        if (err || !result) {
          console.error(err);
          return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
        }
        
        info.storage = storageVersion;
        info.storage.srvDate = result.srvDate.getTime();
        info.storage.srvDateString = result.srvDate.toISOString();

        res.json(info);
      });
    });  
  });

  return api;
}
module.exports = configure;
