'use strict';

const  apiConst = require('../../const.json')
  , stringTools = require('../../shared/stringTools')
  , opTools = require('../../shared/operationTools')
  ;


/**
 * Validation of document to create
 * @param {Object} opCtx
 * @param {Object} doc
 * @returns string with error message if validation fails, true in case of success
 */
function validate (opCtx, doc) {

  const { res } = opCtx;

  if (typeof(doc.identifier) !== 'string' || stringTools.isNullOrWhitespace(doc.identifier)) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_FIELD_IDENTIFIER);
  }

  return opTools.validateCommon(doc, res);
}

module.exports = validate;