'use strict';

const apiConst = require('../../const.json')
  , security = require('../../security')
  , validate = require('./validate.js')
  , documentLocation = require('../../shared/documentLocation')
  , opTools = require('../../shared/operationTools')
  , srvDates = require('../../../server/srv-dates')
  , targetUnits = require('../../../treatmentTargetUnits')
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

  // A Temporary Target is stored in mg/dL (BF-194), after validation.
  if (col.colName === 'treatments')
    targetUnits.normalizeTargetUnits(doc);

  // One clock for every writer, so history never sees two writes with the
  // same srvModified (see lib/server/srv-dates.js).
  const now = new Date(srvDates.next());
  doc.srvModified = now.getTime();
  doc.srvCreated = doc.srvModified;

  if (auth && auth.subject && auth.subject.name) {
    doc.subject = auth.subject.name;
  }

  const identifier = await col.storage.insertOne(doc);

  if (!identifier)
    throw new Error('empty identifier');

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
