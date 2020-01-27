'use strict';

const apiConst = require('../../const.json')
  , security = require('../../security')
  , opTools = require('../../shared/operationTools')
  , dateTools = require('../../shared/dateTools')
  , renderer = require('../../shared/renderer')
  , FieldsProjector = require('../../shared/fieldsProjector')
  ;

/**
  * READ: Retrieves a single document from the collection
  */
async function read (opCtx) {

  const { req, res, col } = opCtx;

  await security.demandPermission(opCtx, `api:${col.colName}:read`);

  const fieldsProjector = new FieldsProjector(req.query.fields);

  const result = await col.storage.findOne(req.params.identifier
    , fieldsProjector.storageProjection());

  if (!result)
    throw new Error('empty result');

  if (result.length === 0) {
    return res.status(apiConst.HTTP.NOT_FOUND).end();
  }

  const doc = result[0];
  if (doc.isValid === false) {
    return res.status(apiConst.HTTP.GONE).end();
  }


  const modifiedDate = col.resolveDates(doc);
  if (modifiedDate) {
    res.setHeader('Last-Modified', modifiedDate.toUTCString());

    const ifModifiedSince = req.get('If-Modified-Since');

    if (ifModifiedSince
      && dateTools.floorSeconds(modifiedDate) <= dateTools.floorSeconds(new Date(ifModifiedSince))) {
      return res.status(apiConst.HTTP.NOT_MODIFIED).end();
    }
  }

  fieldsProjector.applyProjection(doc);

  res.status(apiConst.HTTP.OK);
  renderer.render(res, doc);
}


function readOperation (ctx, env, app, col) {

  return async function operation (req, res) {

    const opCtx = { app, ctx, env, col, req, res };

    try {
      opCtx.auth = await security.authenticate(opCtx);

      await read(opCtx);

    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        return opTools.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }
  };
}

module.exports = readOperation;