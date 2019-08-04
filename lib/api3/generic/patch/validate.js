'use strict';

const _ = require('lodash')
  , apiConst = require('../../const.json')
  , opTools = require('../../shared/operationTools')
  , stringTools = require('../../shared/stringTools')
  ;


/**
 * Validate document to patch
 * @param {any} doc
 * @returns null if validation fails
 */
function validate (opCtx, doc) {

  const { res } = opCtx;

  if (_.isEmpty(doc)) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_REQUEST_BODY);
  }

  if (doc.identifier !== undefined)
    delete doc.identifier;

  if (doc.srvModified !== undefined)
    delete doc.srvModified;

  if (doc.srvCreated !== undefined)
    delete doc.srvCreated;

  if (typeof(doc.date) !== 'undefined' &&
    (typeof(doc.date) !== 'number' || doc.date <= apiConst.MIN_TIMESTAMP)) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_FIELD_DATE);
  }

  if (typeof(doc.utcOffset) !== 'undefined' &&
    (typeof(doc.utcOffset) !== 'number'
      || doc.utcOffset < apiConst.MIN_UTC_OFFSET || doc.utcOffset > apiConst.MAX_UTC_OFFSET)) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_FIELD_UTC);
  }

  if (typeof(doc.app) !== 'undefined' &&
    (typeof(doc.app) !== 'string' || stringTools.isNullOrWhitespace(doc.app))) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_FIELD_APP);
  }

  return true;
}

module.exports = validate;