'use strict';

const _ = require('lodash')
  , apiConst = require('../../const.json')
  , opTools = require('../../shared/operationTools')
  ;


/**
 * Validation of document to update
 * @param {any} doc
 * @returns string with error message if validation fails, true in case of success
 */
function validate (opCtx, doc) {

  const { res } = opCtx;

  if (_.isEmpty(doc)) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_REQUEST_BODY);
  }

  return opTools.validateCommon(doc, res);
}

module.exports = validate