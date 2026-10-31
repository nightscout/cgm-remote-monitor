// The pre-move lib/api3/generic/patch/operation.js at dev db3b9e4e,
// kept as the reference the write step is compared with
// (tests/write-intent.v3.test.js). Only the require paths differ from that
// file. Not loaded by the server.
'use strict';

const apiConst = require('../../../lib/api3/const.json')
  , security = require('../../../lib/api3/security')
  , validate = require('../../../lib/api3/generic/patch/validate.js')
  , opTools = require('../../../lib/api3/shared/operationTools')
  , srvDates = require('../../../lib/server/srv-dates')
  , dateTools = require('../../../lib/api3/shared/dateTools')
  , treatmentDuration = require('../../../lib/treatmentDuration')
  , targetUnits = require('../../../lib/treatmentTargetUnits')
  , writePurifier = require('../../../lib/api3/shared/writePurifier')
  , mergePatch = require('../../../lib/server/merge-patch')
  , writeValidation = require('../../../lib/server/write-validation')
  ;

/**
  * PATCH: Partially updates document in the collection
  */
async function patch (opCtx) {

  const { req, res, col } = opCtx;
  const doc = req.body;

  if (!doc || (typeof doc === 'object' && Object.keys(doc).length === 0)) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_REQUEST_BODY);
  }

  await security.demandPermission(opCtx, `api:${col.colName}:update`);

  // The URL names the record, so a body _id can only be an attempt to change
  // its storage key: refuse it as the other immutable fields are refused
  // (BF-170). MongoDB used to refuse the $set, and the client got a 500.
  if (Object.prototype.hasOwnProperty.call(doc, '_id')) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST,
      apiConst.MSG.HTTP_400_IMMUTABLE_FIELD.replace('{0}', '_id'));
  }

  writePurifier.purifyWritableDocument(opCtx, doc);

  // parseDate is not valid for patch operation
  // (it is adding new fields)
  // col.parseDate(doc);
  const identifier = req.params.identifier
    , identifyingFilter = col.storage.identifyingFilter(identifier);

  const result = await col.storage.findOneFilter(identifyingFilter, { });

  if (!result)
    throw new Error('result empty');

  if (result.length > 0) {

    const storageDoc = result[0];
    if (storageDoc.isValid === false) {
      return opTools.sendJSONStatus(res, apiConst.HTTP.GONE);
    }

    const modifiedDate = col.resolveDates(storageDoc)
      , ifUnmodifiedSince = req.get('If-Unmodified-Since');

    if (ifUnmodifiedSince
      && dateTools.floorSeconds(modifiedDate) > dateTools.floorSeconds(new Date(ifUnmodifiedSince))) {
      return opTools.sendJSONStatus(res, apiConst.HTTP.PRECONDITION_FAILED);
    }

    await applyPatch(opCtx, identifier, doc, storageDoc);
  }
  else {
    return opTools.sendJSONStatus(res, apiConst.HTTP.NOT_FOUND);
  }
}


/**
 * Patch existing document in the collection
 * @param {Object} opCtx
 * @param {string} identifier
 * @param {Object} doc - fields and values to patch
 * @param {Object} storageDoc - original (database) version of document
 */
async function applyPatch (opCtx, identifier, doc, storageDoc) {

  const { ctx, res, col, auth } = opCtx;

  if (validate(opCtx, doc, storageDoc) !== true)
    return;

  // One clock for every writer, so history never sees two writes with the
  // same srvModified (see lib/server/srv-dates.js).
  const now = new Date(srvDates.next());
  doc.srvModified = now.getTime();

  if (auth && auth.subject && auth.subject.name) {
    doc.modifiedBy = auth.subject.name;
  }

  // Keep unrelated legacy edits possible in reject mode. Adding derived
  // duration fields to a notes-only patch would turn it into a domain edit at
  // the conditional boundary and refuse an otherwise unchanged old target.
  if (writeValidation.mode(opCtx.env) !== 'reject' || writeValidation.touchesDomain(doc)) {
    treatmentDuration.normalizeTreatmentDuration(doc, storageDoc);
  }

  // A Temporary Target is stored in mg/dL (BF-194), after validation: a
  // patch that sends a target, glucose, units or eventType carries both
  // targets and the label as they will be stored. Other patches leave a
  // stored record as it is.
  if (col.colName === 'treatments')
    targetUnits.normalizeTargetUnits(doc, storageDoc);

  // The body is a JSON Merge Patch (RFC 7386, write-contract Q1b, decided
  // 2026-10-26): a field sent as null is removed from the stored document,
  // at any depth, an object merges into the stored object and anything else,
  // an array included, replaces the stored value. PUT still replaces whole.
  const parts = mergePatch.update(storageDoc, doc);
  const matchedCount = await col.storage.updateOne(identifier, parts.set, parts.unset);

  if (!matchedCount)
    throw new Error('matchedCount empty');

  res.setHeader('Last-Modified', now.toUTCString());
  opTools.sendJSONStatus(res, apiConst.HTTP.OK);

  const patchedDoc = mergePatch.assignInto(Object.assign({}, storageDoc), parts);
  ctx.bus.emit('storage-socket-update', { colName: col.colName, doc: patchedDoc });

  col.autoPrune();
  ctx.bus.emit('data-received');
}


function patchOperation (ctx, env, app, col) {

  return async function operation (req, res) {

    const opCtx = { app, ctx, env, col, req, res };

    try {
      opCtx.auth = await security.authenticate(opCtx);

      await patch(opCtx);

    } catch (err) {
      if (!res.headersSent && ['WriteValidationError', 'WriteConflictError'].includes(err.name)) {
        return opTools.sendJSONStatus(res, err.status, err.message);
      }
      console.error(err);
      if (!res.headersSent) {
        return opTools.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }
  };
}

module.exports = patchOperation;
