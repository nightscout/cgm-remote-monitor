'use strict';

const apiConst = require('../../const.json')
  , security = require('../../security')
  , validate = require('./validate.js')
  , documentLocation = require('../../shared/documentLocation')
  , opTools = require('../../shared/operationTools')
  , writeIntent = require('../../../storage/write-intent')
  ;

/**
 * Replace existing document in the collection
 * @param {Object} opCtx
 * @param {any} doc - new version of document to set
 * @param {any} storageDoc - old version of document (existing in the storage)
 * @param {Object} options
 */
async function replace (opCtx, doc, storageDoc, options) {

  const { ctx, auth, col, res } = opCtx;
  const { isDeduplication } = options || {};

  await security.demandPermission(opCtx, `api:${col.colName}:update`);

  if (validate(opCtx, doc, storageDoc, { isDeduplication }) !== true)
    return;

  // The write step (lib/storage/write-intent.js) stamps the server dates
  // (srvCreated carried) and the subject, derives endmills from a duration,
  // stores a Temporary Target in mg/dL (BF-194), and writes by the stored
  // record's identifier through the cached storage: a PUT replaces it; a POST
  // that matched it (isDeduplication) is a create the step merges into it
  // (merge on match, ID-Q8), or replaces where the collection's rule says so.
  const written = await writeIntent.forCollection(col.storage, col.colName, 'v3', { env: opCtx.env })
    .write({ op: isDeduplication ? 'create' : 'update', docs: [doc]
      , target: { identifier: storageDoc.identifier, stored: storageDoc }
      , by: auth && auth.subject && auth.subject.name });
  const matchedCount = written.adapter;

  if (!matchedCount)
    throw new Error('empty matchedCount');

  const now = new Date(doc.srvModified);
  res.setHeader('Last-Modified', now.toUTCString());
  const fields = {
    lastModified: now.getTime()
  }

  if (storageDoc.identifier !== doc.identifier || isDeduplication) {
    res.setHeader('Location', documentLocation(col.colName, doc.identifier));
    fields.identifier = doc.identifier;
    fields.isDeduplication = true;
    if (storageDoc.identifier !== doc.identifier) {
      fields.deduplicatedIdentifier = storageDoc.identifier;
    }
  }

  opTools.sendJSON({ res, status: apiConst.HTTP.OK, fields });

  // A merge announces the record as it now is.
  ctx.bus.emit('storage-socket-update', { colName: col.colName, doc: written.patched || doc });
  col.autoPrune();
  ctx.bus.emit('data-received');
}


module.exports = replace;
