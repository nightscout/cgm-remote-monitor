'use strict';

const apiConst = require('../../const.json')
  , security = require('../../security')
  , validate = require('../update/validate.js')
  , documentLocation = require('../../shared/documentLocation')
  , opTools = require('../../shared/operationTools')
  , idForms = require('../../../server/object-id-forms')
  ;

// A devicestatus POSTed with the identifier of a status already stored is
// acknowledged and not written again (ID-SIMPLE-MATCH, devicestatus option
// (b), decided 2026-10-26), as v1 does for the same re-send: a status is a
// snapshot, and its identifier names the one already stored. Nothing is
// replaced and the stored status's srvModified is unchanged. The reply keeps
// the deduplication shape a replace sends (200, isDeduplication, the stored
// identifier, Last-Modified and Location), so a client that stores the
// identifier from it reads the same fields.
//
// Only devicestatus, and only when the stored status answers to the same
// identifier: the one it is stored or shown under, or for a 24-hex
// identifier that _id in either hex case, as the identifying filter matches
// it. A match through the created_at + device fallback (a stored status with
// no identifier of its own) and every other collection still replace the
// stored document, as before.
function sameIdentifier (stored, sent) {
  if (stored === sent) return true;
  return idForms.isHexId(stored) && idForms.isHexId(sent) && stored.toLowerCase() === sent.toLowerCase();
}

function applies (col, doc, storageDoc) {
  return col.colName === 'devicestatus' && sameIdentifier(storageDoc.identifier, doc.identifier);
}

// The same permission and the same checks a deduplicating replace makes, so
// a request that one refuses the other refuses too; then the reply, with no
// write, no storage-socket update and no data-received.
async function acknowledge (opCtx, doc, storageDoc) {

  const { col, res } = opCtx;

  await security.demandPermission(opCtx, `api:${col.colName}:update`);

  if (validate(opCtx, doc, storageDoc, { isDeduplication: true }) !== true)
    return;

  const fields = {
    identifier: storageDoc.identifier,
    isDeduplication: true
  };
  // When the stored status was last written: its srvModified, or for a
  // status stored without one, its srvCreated.
  const lastModified = typeof storageDoc.srvModified === 'number' ? storageDoc.srvModified : storageDoc.srvCreated;
  if (typeof lastModified === 'number') {
    fields.lastModified = lastModified;
    res.setHeader('Last-Modified', new Date(lastModified).toUTCString());
  }
  res.setHeader('Location', documentLocation(col.colName, storageDoc.identifier));

  opTools.sendJSON({ res, status: apiConst.HTTP.OK, fields });
}

acknowledge.applies = applies;

module.exports = acknowledge;
