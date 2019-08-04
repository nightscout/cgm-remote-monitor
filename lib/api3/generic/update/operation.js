'use strict';

const dateTools = require('../../shared/dateTools')
  , apiConst = require('../../const.json')
  , security = require('../../security')
  , validate = require('./validate.js')
  , insert = require('../create/insert')
  , replace = require('./replace')
  , opTools = require('../../shared/operationTools')
  ;

/**
  * UPDATE: Updates a document in the collection
  */
async function update (opCtx) {

  const { col, req } = opCtx;
  const doc = req.body;
  col.parseDate(doc);

  if (validate(opCtx, doc) !== true)
    return;

  const identifier = req.params.identifier
    , identifyingFilter = col.storage.identifyingFilter(identifier);

  const result = await col.storage.findOneFilter(identifyingFilter, { });

  if (!result)
    throw new Error('empty result');

  doc.identifier = identifier;

  if (result.length > 0) {
    await updateConditional(opCtx, doc, result[0]);
  }
  else {
    await insert(opCtx, doc);
  }
}


async function updateConditional (opCtx, doc, storageDoc) {

  const { col, req, res } = opCtx;

  if (storageDoc.isValid === false) {
    return res.status(apiConst.HTTP.GONE).end();
  }

  const modifiedDate = col.resolveDates(storageDoc)
    , ifUnmodifiedSince = req.get('If-Unmodified-Since');

  if (ifUnmodifiedSince
    && dateTools.floorSeconds(modifiedDate) > dateTools.floorSeconds(new Date(ifUnmodifiedSince))) {
    return res.status(apiConst.HTTP.PRECONDITION_FAILED).end();
  }

  await replace(opCtx, doc, storageDoc);
}


function updateOperation (ctx, env, app, col) {

  return async function operation (req, res) {

    const opCtx = { app, ctx, env, col, req, res };

    try {
      opCtx.auth = await security.authenticate(opCtx);

      await update(opCtx);

    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        return opTools.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }
  };
}

module.exports = updateOperation;