'use strict';

const apiConst = require('../../const.json')
  , security = require('../../security')
  , opTools = require('../../shared/operationTools')
  , renderer = require('../../shared/renderer')
  , input = require('./input')
  , _each = require('lodash/each')
  , FieldsProjector = require('../../shared/fieldsProjector')
  ;


/**
  * SEARCH: Search documents from the collection
  */
async function search (opCtx) {

  const { req, res, col } = opCtx;

  if (col.colName === 'settings') {
    await security.demandPermission(opCtx, `api:${col.colName}:admin`);
  } else {
    await security.demandPermission(opCtx, `api:${col.colName}:read`);
  }

  const fieldsProjector = new FieldsProjector(req.query.fields);

  const filter = input.parseFilter(req, res)
    , sort = input.parseSort(req, res)
    , limit = col.parseLimit(req, res)
    , skip = input.parseSkip(req, res)
    , projection = fieldsProjector.storageProjection()
    , onlyValid = true
    ;


  if (filter !== null && sort !== null && limit !== null && skip !== null && projection !== null) {

    const result = await col.storage.findMany(filter
      , sort
      , limit
      , skip
      , projection
      , onlyValid);

    if (!result)
      throw new Error('empty result');

    _each(result, col.resolveDates);

    _each(result, fieldsProjector.applyProjection);

    res.status(apiConst.HTTP.OK);
    renderer.render(res, result);
  }
}


function searchOperation (ctx, env, app, col) {

  return async function operation (req, res) {

    const opCtx = { app, ctx, env, col, req, res };

    try {
      opCtx.auth = await security.authenticate(opCtx);

      await search(opCtx);

    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        return opTools.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }
  };
}

module.exports = searchOperation;