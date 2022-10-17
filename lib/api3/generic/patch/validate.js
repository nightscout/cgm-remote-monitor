'use strict';

const updateValidate = require('../update/validate')
  ;


/**
 * Validate document to patch
 * @param {Object} opCtx
 * @param {Object} doc
 * @param {Object} storageDoc
 * @returns string - null if validation fails
 */
function validate (opCtx, doc, storageDoc) {

  return updateValidate(opCtx, doc, storageDoc, { isPatching: true });
}

module.exports = validate;