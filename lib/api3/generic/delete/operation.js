'use strict';

const apiConst = require('../../const.json')
  , security = require('../../security')
  , opTools = require('../../shared/operationTools')
  ;

/**
 * DELETE: Deletes a document from the collection
 */
async function doDelete (opCtx) {

  const { col, req } = opCtx;

  await security.demandPermission(opCtx, `api:${col.colName}:delete`);

  if (await validateDelete(opCtx) !== true)
    return;

  if (req.query.permanent && req.query.permanent === "true") {
    await deletePermanently(opCtx);
  } else {
    await markAsDeleted(opCtx);
  }
}


async function validateDelete (opCtx) {

  const { col, req, res } = opCtx;

  const identifier = req.params.identifier;
  const result = await col.storage.findOne(identifier);

  if (!result)
    throw new Error('empty result');

  if (result.length === 0) {
    return res.status(apiConst.HTTP.NOT_FOUND).end();
  }
  else {
    const storageDoc = result[0];

    if (storageDoc.isReadOnly === true || storageDoc.readOnly === true || storageDoc.readonly === true) {
      return opTools.sendJSONStatus(res, apiConst.HTTP.UNPROCESSABLE_ENTITY,
        apiConst.MSG.HTTP_422_READONLY_MODIFICATION);
    }
  }

  return true;
}


async function deletePermanently (opCtx) {

  const { ctx, col, req, res } = opCtx;

  const identifier = req.params.identifier;
  const result = await col.storage.deleteOne(identifier);

  if (!result)
    throw new Error('empty result');

  if (!result.deleted) {
    return res.status(apiConst.HTTP.NOT_FOUND).end();
  }

  col.autoPrune();
  ctx.bus.emit('storage-socket-delete', { colName: col.colName, identifier });
  ctx.bus.emit('data-received');
  return res.status(apiConst.HTTP.NO_CONTENT).end();
}


async function markAsDeleted (opCtx) {

  const { ctx, col, req, res, auth } = opCtx;

  const identifier = req.params.identifier;
  const setFields = { 'isValid': false, 'srvModified': (new Date).getTime() };

  if (auth && auth.subject && auth.subject.name) {
    setFields.modifiedBy = auth.subject.name;
  }

  const result = await col.storage.updateOne(identifier, setFields);

  if (!result)
    throw new Error('empty result');

  if (!result.updated) {
    return res.status(apiConst.HTTP.NOT_FOUND).end();
  }

  ctx.bus.emit('storage-socket-delete', { colName: col.colName, identifier });
  col.autoPrune();
  ctx.bus.emit('data-received');
  return res.status(apiConst.HTTP.NO_CONTENT).end();
}


function deleteOperation (ctx, env, app, col) {

  return async function operation (req, res) {

    const opCtx = { app, ctx, env, col, req, res };

    try {
      opCtx.auth = await security.authenticate(opCtx);

      await doDelete(opCtx);

    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        return opTools.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }
  };
}

module.exports = deleteOperation;