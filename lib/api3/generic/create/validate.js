'use strict';

const _ = require('lodash')
  , apiConst = require('../../const.json')
  , stringTools = require('../../shared/stringTools')
  , opTools = require('../../shared/operationTools')
  ;


/**
 * Basic validation of document to create
 * @param {any} doc
 * @returns string with error message if validation fails, true in case of success
 */
function validateBasic (doc, opCtx) {

  const { res } = opCtx;

  if (_.isEmpty(doc)) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_REQUEST_BODY);
  }

  if (typeof(doc.identifier) !== 'string' || stringTools.isNullOrWhitespace(doc.identifier)) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_FIELD_IDENTIFIER);
  }

  return opTools.validateCommon(doc, res);
}

module.exports = {
  validateBasic
}