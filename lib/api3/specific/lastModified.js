'use strict';

const _ = require('lodash')
  , async = require('async')
  , apiConst = require('../const.json')
  ;


function configure (app, ctx, env, authBuilder) {
  const express = require('express')
    , api = express.Router( )
    , storageTools = require('../shared/storageTools')(app)

  api.get('/lastModified', function getLastModified (req, res) {

    function getLastModified (col) {

      return new Promise(async function (resolve, reject) {

        try {
          let result;
          const lastModified = await col.storage.getLastModified('srvModified');

          if (lastModified) {
            result = lastModified.srvModified ? lastModified.srvModified : null;
          }

          if (col.fallbackTimestampField) {

            const lastModified = await col.storage.getLastModified(col.fallbackTimestampField);

            if (lastModified && lastModified[col.fallbackTimestampField]) {
              let timestamp = lastModified[col.fallbackTimestampField];
              if (typeof(timestamp) === 'string') {
                timestamp = (new Date(timestamp)).getTime();
              }

              if (result === null || result < timestamp) {
                result = timestamp;
              }
            }
          }
            
          resolve({ colName: col.colName, lastModified: result });
        } catch (err) {
          reject(err);
        }
      });
    }

    
    function collectionsAsync (req) {

      return new Promise(function (resolve, reject) {
        const cols = app.get('collections')
          , promises = []
          , output = {}
        
        for (const colName in cols) {
          const col = cols[colName];

          if (authBuilder.checkPermission(req, 'api:' + col.colName + ':read')) {
            promises.push(getLastModified(col));
          }
        }

        Promise.all(promises)
        .then(function allDone (results) {
        
          for (const result of results) {
            if (result.lastModified)
              output[result.colName] = result.lastModified;
          }

          resolve(output);        
        }, reject);
      });
    }


    authBuilder.authorizerFor()(req, res, async function authorized () {

      try {
        const { srvDate } = await storageTools.getStorageCurrentDate();
        if (!srvDate)
          throw 'empty currentDate';

        let info = { 
          srvDate: srvDate.getTime(),
          srvDateString: srvDate.toISOString(),
          collections: { }
        };

        info.collections = await collectionsAsync(req, res);
        
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
