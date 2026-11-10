'use strict';

const apiConst = require('../../const.json')
  , security = require('../../security')
  , insert = require('./insert')
  , replace = require('../update/replace')
  , validate = require('./validate')
  , opTools = require('../../shared/operationTools')
  , writePurifier = require('../../shared/writePurifier')
  , mongoUtils = require('../../storage/mongoCollection/utils')
  ;


/**
 * CREATE: Inserts a new document into the collection
 */
async function create (opCtx) {

  const { col, req, res } = opCtx;
  const doc = req.body;

  if (!doc || (typeof doc === 'object' && Object.keys(doc).length === 0)) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_REQUEST_BODY);
  }

  // POST may resolve to either an insert or a deduplicating replacement.
  // Reject callers that cannot perform either operation before processing
  // the request; the selected branch demands the
  // exact create/update permission below.
  const canCreate = security.checkPermission(opCtx.auth, `api:${col.colName}:create`)
    , canUpdate = security.checkPermission(opCtx.auth, `api:${col.colName}:update`);
  if (!canCreate && !canUpdate) {
    await security.demandPermission(opCtx, `api:${col.colName}:create`);
  }

  writePurifier.purifyWritableDocument(opCtx, doc);
  col.parseDate(doc);
  opTools.resolveIdentifier(doc);

  // Validate identifier/dedup fields before using them in a MongoDB selector.
  if (validate(opCtx, doc) !== true)
    return;

  const identifyingFilter = col.storage.identifyingFilter(doc.identifier, doc, col.dedupFallbackFields);

  const result = await col.storage.findOneFilter(identifyingFilter, { }, { normalize: false });

  if (!result)
    throw new Error('empty result');

  if (result.length > 0) {
    const storageDoc = result[0];
    const isLegacyEntry = col.colName === 'entries'
      && !Object.prototype.hasOwnProperty.call(storageDoc, 'identifier')
      && doc.date === storageDoc.date && doc.type === storageDoc.type;
    mongoUtils.normalizeDoc(storageDoc);
    await replace(opCtx, doc, storageDoc, { isDeduplication: true, isLegacyEntry });
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
