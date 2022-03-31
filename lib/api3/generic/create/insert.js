'use strict';

const apiConst = require('../../const.json')
  , security = require('../../security')
  , validate = require('./validate.js')
  , path = require('path')
  ;

/**
 * Insert new document into the collection
 * @param {Object} opCtx
 * @param {Object} doc
 */
async function insert (opCtx, doc) {

  const { ctx, auth, col, req, res } = opCtx;

  await security.demandPermission(opCtx, `api:${col.colName}:create`);

  if (validate(opCtx, doc) !== true)
    return;

  const now = new Date;
  doc.srvModified = now.getTime();
  doc.srvCreated = doc.srvModified;

  if (auth && auth.subject && auth.subject.name) {
    doc.subject = auth.subject.name;
  }

  const identifier = await col.storage.insertOne(doc);

  if (!identifier)
    throw new Error('empty identifier');

  res.setHeader('Last-Modified', now.toUTCString());
  res.setHeader('Location', path.posix.join(req.baseUrl, req.path, identifier));
  res.status(apiConst.HTTP.CREATED).send({ });

  ctx.bus.emit('storage-socket-create', { colName: col.colName, doc });
  col.autoPrune();
  ctx.bus.emit('data-received');
}


module.exports = insert;