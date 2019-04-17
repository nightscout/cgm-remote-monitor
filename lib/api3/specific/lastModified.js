'use strict';

var _ = require('lodash')
  , async = require('async');

function configure (app, ctx, env, authBuilder) {
  var express = require('express')
    , api = express.Router( )

  api.get('/lastModified', function getLastModified (req, res) {
    var date = new Date();
    var info = { srvDate: date.getTime()
      , srvDateString: date.toISOString()
      , collections: { }
    };

    function historyInfoFor (colName, col) {
      col.storage.getLastModified(function done (err, result) {
        if (err) {
          throw err;
        }

        if (result) {
          return result.srvModified;
        }

        return null;
      });
    }


    authBuilder.authorizerFor()(req, res, function authorized () {

      var cols = app.get('collections')
        , wasError = false;

      async.each(_.values(cols), function loadOne (col, callback) {

        try {
          if (!authBuilder.checkPermission(req, 'api:' + col.colName + ':read')) {
            return callback();
          }

          col.storage.getLastModified(function getLastModifiedDone (err, result) {
            if (err) {
              return callback(err);
            }

            if (result) {
              info.collections[col.colName] = result.srvModified ? result.srvModified : null;
            }

            return callback();
          });
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
    });

  });

  return api;
}
module.exports = configure;
