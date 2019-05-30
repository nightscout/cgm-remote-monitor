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

    var storage = app.get('entriesCollection').storage
      , storageVersion = app.get('storageVersion')
      ;

    storage.currentDate(function currentDateDone (err, result) {
      if (err || !result) {
        console.error(err);
        return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }

      info.storage = {};
      if (storageVersion) {
        info.storage.type = storageVersion.storage;
        info.storage.version = storageVersion.version;
      }
      info.storage.srvDate = result.srvDate.getTime();
      info.storage.srvDateString = result.srvDate.toISOString();

      res.json(info);
    });  
  });

  return api;
}
module.exports = configure;
