'use strict';

const apiConst = require('../../const.json')
  , security = require('../../security')
  , validate = require('../update/validate.js')
  , documentLocation = require('../../shared/documentLocation')
  , opTools = require('../../shared/operationTools')
  ;

// A POST that is answered without a write: one whose identifier names a
// soft-deleted record (on-deleted, ID-Q4), or one the collection's re-send
// rule acknowledges (lib/storage/write-intent.js; operation.js asks the write
// step). Nothing is written, the stored record's srvModified is unchanged, and
// a deleted record stays deleted. The reply keeps the deduplication shape a
// replace sends (200, isDeduplication, the stored identifier, Last-Modified
// and Location), so a client that stores the identifier from it reads the same
// fields.
//
// A device status POSTed with the identifier of a stored status was answered
// here from #8859 (ID-SIMPLE-MATCH option (b)) until ID-FIRST-MATCH slice 4:
// it is now merged into the stored status (ID-Q2), as every other collection's
// re-send is (ID-Q8).

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

module.exports = acknowledge;
