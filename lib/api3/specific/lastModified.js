'use strict';

function configure (app, ctx, env) {
  const express = require('express')
    , api = express.Router( )
    , apiConst = require('../const.json')
    , security = require('../security')
    , opTools = require('../shared/operationTools')
  ;

  api.get('/lastModified', async function getLastModified (req, res) {

    async function getLastModified (col) {

      let result;
      const lastModified = await col.storage.getLastModified('srvModified');

      if (lastModified) {
        result = lastModified.srvModified ? lastModified.srvModified : null;
      }

      if (col.fallbackDateField) {

        const lastModified = await col.storage.getLastModified(col.fallbackDateField);

        if (lastModified && lastModified[col.fallbackDateField]) {
          let timestamp = lastModified[col.fallbackDateField];
          if (typeof(timestamp) === 'string') {
            timestamp = (new Date(timestamp)).getTime();
          }

          if (result === null || result < timestamp) {
            result = timestamp;
          }
        }
      }

      return { colName: col.colName, lastModified: result };
    }

    
    async function collectionsAsync (auth) {

      const cols = app.get('collections')
        , promises = []
        , output = {}
        ;

      for (const colName in cols) {
        const col = cols[colName];

        if (security.checkPermission(auth, 'api:' + col.colName + ':read')) {
          promises.push(getLastModified(col));
        }
      }

      const results = await Promise.all(promises);

      for (const result of results) {
        if (result.lastModified)
          output[result.colName] = result.lastModified;
      }

      return output;
    }


    async function operation (opCtx) {

      const { res, auth } = opCtx;
      const srvDate = new Date();

      let info = {
        srvDate: srvDate.getTime(),
        collections: { }
      };

      info.collections = await collectionsAsync(auth);

      res.json(info);
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
