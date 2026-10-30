'use strict';

const apiConst = require('../../const.json')
  , security = require('../../security')
  , insert = require('./insert')
  , replace = require('../update/replace')
  , validate = require('./validate')
  , opTools = require('../../shared/operationTools')
  , writePurifier = require('../../shared/writePurifier')
  , acknowledge = require('./acknowledge')
  , writeIntent = require('../../../storage/write-intent')
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

  if (opTools.refuseClientId(doc, res))
    return;

  writePurifier.purifyWritableDocument(opCtx, doc);
  col.parseDate(doc);

  // identifier-format (ID-Q6), after the _id step (refuseClientId): an invalid
  // identifier is treated as absent, so one is computed below; under
  // WRITE_IDENTIFIER=strict the document is refused as an invalid identifier.
  const step = writeIntent.forCollection(col.storage, col.colName, 'v3', { env: opCtx.env });
  if (step.identifiers([doc]).length > 0) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_FIELD_IDENTIFIER);
  }
  opTools.resolveIdentifier(doc);

  // Validate identifier/dedup fields before using them in a MongoDB selector.
  if (validate(opCtx, doc) !== true)
    return;

  // The identifying read is the write step's (lib/storage/write-intent.js,
  // identifier-match): the record the identifier names, or a record with no
  // identifier matching the fallback fields; null when there is none.
  const storageDoc = await step
    .match({ op: 'create', docs: [doc], fallbackFields: col.dedupFallbackFields });

  if (storageDoc) {
    if (acknowledge.applies(col, doc, storageDoc)) {
      await acknowledge(opCtx, doc, storageDoc);
    } else {
      await replace(opCtx, doc, storageDoc, { isDeduplication: true });
    }
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
