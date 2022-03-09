'use strict';

const apiConst = require('../../const.json')
  , security = require('../../security')
  , validate = require('./validate.js')
  , path = require('path')
  , opTools = require('../../shared/operationTools')
  ;

/**
 * Replace existing document in the collection
 * @param {Object} opCtx
 * @param {any} doc - new version of document to set
 * @param {any} storageDoc - old version of document (existing in the storage)
 * @param {Object} options
 */
async function replace (opCtx, doc, storageDoc, options) {

  const { ctx, auth, col, req, res } = opCtx;
  const { isDeduplication } = options || {};

  await security.demandPermission(opCtx, `api:${col.colName}:update`);

  if (validate(opCtx, doc, storageDoc, { isDeduplication }) !== true)
    return;

  const now = new Date;
  doc.srvModified = now.getTime();
  doc.srvCreated = storageDoc.srvCreated || doc.srvModified;

  if (auth && auth.subject && auth.subject.name) {
    doc.subject = auth.subject.name;
  }

  const matchedCount = await col.storage.replaceOne(storageDoc.identifier, doc);

  if (!matchedCount)
    throw new Error('empty matchedCount');

  res.setHeader('Last-Modified', now.toUTCString());
  const fields = {
    lastModified: now.getTime()
  }

  if (storageDoc.identifier !== doc.identifier || isDeduplication) {
    res.setHeader('Location', path.posix.join(req.baseUrl, req.path, doc.identifier));
    fields.identifier = doc.identifier;
    fields.isDeduplication = true;
    if (storageDoc.identifier !== doc.identifier) {
      fields.deduplicatedIdentifier = storageDoc.identifier;
    }
  }

  opTools.sendJSON({ res, status: apiConst.HTTP.OK, fields });

  ctx.bus.emit('storage-socket-update', { colName: col.colName, doc });
  col.autoPrune();
  ctx.bus.emit('data-received');
}


module.exports = replace;
