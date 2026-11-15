'use strict';

const apiConst = require('../../const.json')
  , opTools = require('../../shared/operationTools')
  , dateTools = require('../../shared/dateTools')
  ;


/**
 * A record created through API v1 (or by another uploader) lacks some of the
 * fields API v3 treats as immutable. Sending such a field is not a change
 * when it states nothing the stored record contradicts:
 * - app and device: v1 does not record them, so the first value is accepted
 *   (a value the record already has still cannot be changed);
 * - isValid: a record without it is valid, so true is the same value (false
 *   is a deletion, which stays with DELETE);
 * - date: a record without it takes its time from the collection's fallback
 *   date field (created_at for treatments), so the same instant is accepted.
 * Every other immutable field is compared as stored: identifier is always
 * present (it falls back to _id), and the server-managed fields cannot be
 * set by the client.
 * @param {string} field
 * @param {any} value - value sent by the client
 * @param {Object} storageDoc
 * @param {Object} col
 * @returns {boolean} true when value is not a modification of the stored document
 */
function isSameAsStored (field, value, storageDoc, col) {

  if (value === storageDoc[field])
    return true;

  if (typeof(storageDoc[field]) !== 'undefined')
    return false;

  switch (field) {
    case 'app':
    case 'device':
      return true;

    case 'isValid':
      return value === true;

    case 'date': {
      const fallbackField = col && col.fallbackDateField;
      if (!fallbackField || fallbackField === 'date')
        return false;
      const m = dateTools.parseToMoment(storageDoc[fallbackField]);
      return !!(m && m.isValid()) && value === m.valueOf();
    }

    default:
      return false;
  }
}


/**
 * Validation of document to update
 * @param {Object} opCtx
 * @param {Object} doc
 * @param {Object} storageDoc
 * @param {Object} options
 * @returns string with error message if validation fails, true in case of success
 */
function validate (opCtx, doc, storageDoc, options) {

  const { res, col } = opCtx;
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

    if (typeof(doc[field]) !== 'undefined' && !isSameAsStored(field, doc[field], storageDoc, col)) {
      return opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST,
        apiConst.MSG.HTTP_400_IMMUTABLE_FIELD.replace('{0}', field));
    }
  }

  return opTools.validateCommon(doc, res, { isPatching });
}

module.exports = validate;
