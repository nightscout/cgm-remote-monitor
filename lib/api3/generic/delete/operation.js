'use strict';

const apiConst = require('../../const.json')
  , security = require('../../security')
  , opTools = require('../../shared/operationTools')
  , writeIntent = require('../../../storage/write-intent')
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
    return opTools.sendJSON({ res, status: apiConst.HTTP.NOT_FOUND });
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
  // Every stored form removed by the write step (lib/storage/write-intent.js).
  const written = await writeIntent.forCollectionResolved(col.storage, col.colName, 'v3', { env: opCtx.env })
    .write({ op: 'delete', form: 'permanent', target: { identifier } });

  if (!written.adapter)
    throw new Error('empty result');

  if (written.items[0].outcome === 'not-found') {
    return opTools.sendJSON({ res, status: apiConst.HTTP.NOT_FOUND });
  }

  col.autoPrune();
  ctx.bus.emit('storage-socket-delete', { colName: col.colName, identifier });
  ctx.bus.emit('data-received');
  return opTools.sendJSON({ res, status: apiConst.HTTP.OK });
}


async function markAsDeleted (opCtx) {

  const { ctx, col, req, res, auth } = opCtx;

  const identifier = req.params.identifier;
  // Every stored form marked isValid: false, with a new srvModified and
  // modifiedBy, by the write step (lib/storage/write-intent.js).
  const written = await writeIntent.forCollectionResolved(col.storage, col.colName, 'v3', { env: opCtx.env })
    .write({ op: 'delete', form: 'mark', target: { identifier }, by: auth && auth.subject && auth.subject.name });

  if (!written.adapter)
    throw new Error('empty result');

  if (written.items[0].outcome === 'not-found') {
    return opTools.sendJSON({ res, status: apiConst.HTTP.NOT_FOUND });
  }

  ctx.bus.emit('storage-socket-delete', { colName: col.colName, identifier });
  col.autoPrune();
  ctx.bus.emit('data-received');
  return opTools.sendJSON({ res, status: apiConst.HTTP.OK });
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
