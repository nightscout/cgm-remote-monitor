'use strict';

const apiConst = require('../../const.json')
  , security = require('../../security')
  , validate = require('./validate.js')
  , opTools = require('../../shared/operationTools')
  , dateTools = require('../../shared/dateTools')
  , writePurifier = require('../../shared/writePurifier')
  , writeIntent = require('../../../storage/write-intent')
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
  // The identifying read is the write step's (lib/storage/write-intent.js,
  // identifier-match): the record the route's identifier names, or null. Of
  // several records that store the identifier, the one P4 picks by the
  // body's time key, else the newest (ID-Q5), which the patch then writes.
  const identifier = req.params.identifier;
  const storageDoc = await writeIntent.forCollectionIntent(col.storage, col.colName, 'v3', { env: opCtx.env, bus: opCtx.ctx && opCtx.ctx.bus })
    .match({ op: 'patch', docs: [doc], target: { identifier } });

  if (storageDoc) {

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
  const step = writeIntent.forCollectionIntent(col.storage, col.colName, 'v3', { env: opCtx.env, bus: opCtx.ctx && opCtx.ctx.bus });

  // identifier-held (ID-RULE1-EDIT): a body identifier that is not the
  // record's own and that another record holds is answered 409, nothing
  // written. Any other identifier that is not the record's own keeps the
  // immutable-field 400 below.
  if (await step.identifierHeld({ op: 'patch', docs: [doc], target: { identifier, stored: storageDoc } })) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.CONFLICT, writeIntent.IDENTIFIER_HELD_MESSAGE);
  }

  if (validate(opCtx, doc, storageDoc) !== true)
    return;

  // The write step (lib/storage/write-intent.js) stamps srvModified and
  // modifiedBy, derives endmills from a duration (in reject mode only for a
  // patch of the domain fields), stores a Temporary Target in mg/dL against
  // the stored record (BF-194), and writes the body as a JSON Merge Patch
  // (RFC 7386, write-contract Q1b: a null removes the field, an object
  // merges, anything else replaces) by identifier through the cached
  // storage. PUT still replaces whole.
  const written = await step
    .write({ op: 'patch', docs: [doc], target: { identifier, stored: storageDoc }
      , by: auth && auth.subject && auth.subject.name });
  const matchedCount = written.adapter;

  if (!matchedCount)
    throw new Error('matchedCount empty');

  const now = new Date(doc.srvModified);
  res.setHeader('Last-Modified', now.toUTCString());
  opTools.sendJSONStatus(res, apiConst.HTTP.OK);

  ctx.bus.emit('storage-socket-update', { colName: col.colName, doc: written.patched });

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
