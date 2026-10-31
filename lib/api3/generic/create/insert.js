'use strict';

const apiConst = require('../../const.json')
  , security = require('../../security')
  , validate = require('./validate.js')
  , documentLocation = require('../../shared/documentLocation')
  , opTools = require('../../shared/operationTools')
  , writeIntent = require('../../../storage/write-intent')
  ;

/**
 * Insert new document into the collection
 * @param {Object} opCtx
 * @param {Object} doc
 */
async function insert (opCtx, doc) {

  const { ctx, auth, col, res } = opCtx;

  await security.demandPermission(opCtx, `api:${col.colName}:create`);

  if (validate(opCtx, doc) !== true)
    return;

  // The write step (lib/storage/write-intent.js) stores a Temporary Target
  // in mg/dL (BF-194), stamps the server dates and the subject, and inserts
  // by the cached storage.
  const written = await writeIntent.forCollectionResolved(col.storage, col.colName, 'v3', { env: opCtx.env })
    .write({ op: 'create', docs: [doc], by: auth && auth.subject && auth.subject.name });
  const identifier = written.items[0].identifier;

  if (!identifier)
    throw new Error('empty identifier');

  const now = new Date(doc.srvModified);

  res.setHeader('Last-Modified', now.toUTCString());
  res.setHeader('Location', documentLocation(col.colName, identifier));


  const fields = {
    identifier: identifier,
    lastModified: now.getTime()
  };
  opTools.sendJSON({ res, status: apiConst.HTTP.CREATED, fields: fields });

  ctx.bus.emit('storage-socket-create', { colName: col.colName, doc });
  col.autoPrune();
  ctx.bus.emit('data-received');
}


module.exports = insert;
