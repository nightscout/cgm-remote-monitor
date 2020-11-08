'use strict';

const apiConst = require('../../const.json')
  , opTools = require('../../shared/operationTools')
  ;


/**
 * Validation of document to update
 * @param {Object} opCtx
 * @param {Object} doc
 * @param {Object} storageDoc
 * @param {Object} options
 * @returns string with error message if validation fails, true in case of success
 */
function validate (opCtx, doc, storageDoc, options) {

  const { res } = opCtx;
  const { isPatching, isDeduplication } = options || {};

  const immutable = ['identifier', 'date', 'utcOffset', 'eventType', 'device', 'app',
    'srvCreated', 'subject', 'srvModified', 'modifiedBy', 'isValid'];

  if (storageDoc.isReadOnly === true || storageDoc.readOnly === true || storageDoc.readonly === true) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.UNPROCESSABLE_ENTITY,
      apiConst.MSG.HTTP_422_READONLY_MODIFICATION);
  }

  for (const field of immutable) {

    // change of identifier is allowed in deduplication (for APIv1 documents)
    if (field === 'identifier' && isDeduplication)
      continue;

    // changing deleted document is without restrictions
    if (storageDoc.isValid === false)
      continue;

    if (typeof(doc[field]) !== 'undefined' && doc[field] !== storageDoc[field]) {
      return opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST,
        apiConst.MSG.HTTP_400_IMMUTABLE_FIELD.replace('{0}', field));
    }
  }

  return opTools.validateCommon(doc, res, { isPatching });
}

module.exports = validate;