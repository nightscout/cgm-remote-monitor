'use strict';

var _ = require('lodash')
  , async = require('async')
  , apiConst = require('../const.json')
  ;


function configure (app, ctx, env, authBuilder) {
  var express = require('express')
    , api = express.Router( )
    , storageTools = require('../shared/storageTools')(app)

  api.get('/lastModified', function getLastModified (req, res) {

    function getLastModified (col, info, callback) {
      col.storage.getLastModified('srvModified', function getLastModifiedDone (err, result) {
        if (err) {
          return callback(err);
        }

        if (result) {
          info.collections[col.colName] = result.srvModified ? result.srvModified : null;
        }

        if (col.fallbackTimestampField) {

          col.storage.getLastModified(col.fallbackTimestampField, function getLastModifiedDone (err, result) {
            if (err) {
              return callback(err);
            }

            if (result && result[col.fallbackTimestampField]) {
              var timestamp = result[col.fallbackTimestampField];
              if (typeof(timestamp) === 'string') {
                timestamp = (new Date(timestamp)).getTime();
              }

              if (info.collections[col.colName] === null || info.collections[col.colName] < timestamp) {
                info.collections[col.colName] = timestamp;
              }
            }

            return callback();
          });
        }
        else {
          return callback();
        }
      });
    }

    
    function collectionsAsync (req, res, info) {
      var cols = app.get('collections')
        , wasError = false;

      async.each(_.values(cols), function loadOne (col, callback) {

        try {
          if (!authBuilder.checkPermission(req, 'api:' + col.colName + ':read')) {
            return callback();
          }

          getLastModified(col, info, callback);
        }
        catch (e) {
          return callback(e);
        }

      }, function allDone (err) {
        if (err) {
          if (!wasError) {
            wasError = true;
            console.error(err);
            return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
          }
        }
        else {
          res.json(info);
        }
      });
    }


    authBuilder.authorizerFor()(req, res, function authorized () {

      storageTools.getStorageCurrentDate(function currentDateDone (err, result) {
        if (err || !result) {
          console.error(err);
          return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
        }

        var info = { 
          srvDate: result.srvDate.getTime(),
          srvDateString: result.srvDate.toISOString(),
          collections: { }
        };

        collectionsAsync(req, res, info);
      });  

    });

  });

  return api;
}
module.exports = configure;
