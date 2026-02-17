'use strict';

const dateTools = require('../../shared/dateTools')
  , renderer = require('../../shared/renderer')
  , apiConst = require('../../const.json')
  , security = require('../../security')
  , opTools = require('../../shared/operationTools')
  , FieldsProjector = require('../../shared/fieldsProjector')
  , _ = require('lodash')
  ;

/**
 * HISTORY: Retrieves incremental changes since timestamp
 */
async function history (opCtx, fieldsProjector) {

  const { req, res, col } = opCtx;

  let filter = parseFilter(opCtx)
    , limit = col.parseLimit(req, res)
    , projection = fieldsProjector.storageProjection()
    , sort = prepareSort()
    , skip = 0
    , onlyValid = false
    , logicalOperator = 'or'
    ;

  if (filter !== null && limit !== null && projection !== null) {

    const result = await col.storage.findMany({ filter
      , sort
      , limit
      , skip
      , projection
      , onlyValid
      , logicalOperator });

    if (!result)
      throw new Error('empty result');

    if (result.length === 0) {
      res.status(apiConst.HTTP.OK);
      return renderer.render(res, result);
    }

    _.each(result, col.resolveDates);

    const srvModifiedValues = _.map(result, function mapSrvModified (item) {
      return item.srvModified;
    })
      , maxSrvModified = _.max(srvModifiedValues);

    res.setHeader('Last-Modified', (new Date(maxSrvModified)).toUTCString());
    res.setHeader('ETag', 'W/"' + maxSrvModified + '"');

    _.each(result, fieldsProjector.applyProjection);

    res.status(apiConst.HTTP.OK);
    renderer.render(res, result);
  }
}


/**
 * Parse history filtering criteria from Last-Modified header
 */
function parseFilter (opCtx) {

  const { req, res } = opCtx;

  let lastModified = null
    , lastModifiedParam = req.params.lastModified
    , operator = null;

  if (lastModifiedParam) {

    // using param in URL as a source of timestamp
    const m = dateTools.parseToMoment(lastModifiedParam);

    if (m === null || !m.isValid()) {
      opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_LAST_MODIFIED);
      return null;
    }

    lastModified = m.toDate();
    operator = 'gt';
  }
  else {
    // using request HTTP header as a source of timestamp
    const lastModifiedHeader = req.get('Last-Modified');
    if (!lastModifiedHeader) {
      opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_LAST_MODIFIED);
      return null;
    }

    try {
      lastModified = dateTools.floorSeconds(new Date(lastModifiedHeader));
    } catch (err) {
      opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_LAST_MODIFIED);
      return null;
    }
    operator = 'gte';
  }

  return [
    { field: 'srvModified', operator: operator, value: lastModified.getTime() }
  ];
}



/**
 * Prepare sorting for storage query
 */
function prepareSort () {
  return {
    srvModified: 1
  };
}


function historyOperation (ctx, env, app, col) {

  return async function operation (req, res) {

    const opCtx = { app, ctx, env, col, req, res };

    try {
      opCtx.auth = await security.authenticate(opCtx);

      if (col.colName === 'settings') {
        await security.demandPermission(opCtx, `api:${col.colName}:admin`);
      } else {
        await security.demandPermission(opCtx, `api:${col.colName}:read`);
      }

      const fieldsProjector = new FieldsProjector(req.query.fields);

      await history(opCtx, fieldsProjector);

    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        return opTools.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }
  };
}

module.exports = historyOperation;
