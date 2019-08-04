'use strict';

const apiConst = require('../../const.json')
  , security = require('../../security')
  , validate = require('./validate.js')
  , insert = require('./insert')
  , replace = require('../update/replace')
  , opTools = require('../../shared/operationTools')
  ;


/**
 * CREATE: Inserts a new document into the collection
 */
async function create (opCtx) {

  const { col, req } = opCtx;
  const doc = req.body;
  col.parseDate(doc);

  if (validate(opCtx, doc) !== true)
    return;

  const identifyingFilter = col.storage.identifyingFilter(doc.identifier, doc, col.dedupFallbackFields);

  const result = await col.storage.findOneFilter(identifyingFilter, { });

  if (!result)
    throw new Error('empty result');

  if (result.length > 0) {
    const storageDoc = result[0];
    await replace(opCtx, doc, storageDoc);
  }
  else {
    await insert(opCtx, doc);
  }
}


function createOperation (ctx, env, app, col) {

  return async function operation (req, res) {

    const opCtx = { app, ctx, env, col, req, res };

    try {
      opCtx.auth = await security.authenticate(opCtx);

      await create(opCtx);

    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        return opTools.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }
  };
}

module.exports = createOperation;