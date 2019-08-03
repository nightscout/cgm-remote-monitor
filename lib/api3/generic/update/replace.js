'use strict';

const apiConst = require('../../const.json')
  , security = require('../../security')
  ;

/**
 * Replace existing document in the collection
 * @param {any} doc - new version of document to set
 * @param {any} storageDoc - old version of document (existing in the storage)
 */
async function replace (opCtx, doc, storageDoc) {

  const { ctx, auth, col, req, res } = opCtx;

  await security.demandPermission(opCtx, `api:${col.colName}:update`);

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

  if (storageDoc.identifier !== doc.identifier) {
    res.setHeader('Location', `${req.baseUrl}${req.path}/${doc.identifier}`);
  }

  res.status(apiConst.HTTP.NO_CONTENT).send({ });

  ctx.bus.emit('storage-socket-update', { colName: col.colName, doc });
  col.autoPrune();
  ctx.bus.emit('data-received');
}


module.exports = replace;