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
  // by the cached storage. When another upload of the same record inserted
  // first (the unique index on identifier), the step applies this one as the
  // deduplicating POST would, which needs the update permission.
  const written = await writeIntent.forCollectionIntent(col.storage, col.colName, 'v3', { env: opCtx.env, bus: opCtx.ctx && opCtx.ctx.bus })
    .write({ op: 'create', docs: [doc], by: auth && auth.subject && auth.subject.name
      , canUpdate: security.checkPermission(auth, `api:${col.colName}:update`)
      , computedIdentifier: opCtx.computedIdentifier === true });
  const identifier = written.items[0].identifier;

  if (!identifier)
    throw new Error('empty identifier');

  // Another upload of the same record was stored first (the unique index on
  // identifier): the step applied this one as a re-send, so it is answered as
  // a deduplicated POST is, 200 with isDeduplication.
  const outcome = written.items[0].outcome;
  if (outcome === 'merged' || outcome === 'replaced' || outcome === 'unchanged') {
    return answerDeduplicated(opCtx, doc, written.items[0], written.patched);
  }

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


// The reply of a deduplicated POST (update/replace.js, create/acknowledge.js):
// a merge or replace is answered with the new srvModified and announced as an
// update (a merge as the record now is, `patched`); an acknowledged re-send
// with the stored one, and nothing announced.
function answerDeduplicated (opCtx, doc, written, patched) {
  const { ctx, col, res } = opCtx;
  const stored = written.record || { };
  const fields = { identifier: written.identifier, isDeduplication: true };
  const wrote = written.outcome === 'merged' || written.outcome === 'replaced';
  const lastModified = wrote ? doc.srvModified
    : (typeof stored.srvModified === 'number' ? stored.srvModified : stored.srvCreated);
  if (typeof lastModified === 'number') {
    fields.lastModified = lastModified;
    res.setHeader('Last-Modified', new Date(lastModified).toUTCString());
  }
  res.setHeader('Location', documentLocation(col.colName, written.identifier));
  opTools.sendJSON({ res, status: apiConst.HTTP.OK, fields: fields });
  if (wrote) {
    ctx.bus.emit('storage-socket-update', { colName: col.colName, doc: patched || doc });
    col.autoPrune();
    ctx.bus.emit('data-received');
  }
}

module.exports = insert;
