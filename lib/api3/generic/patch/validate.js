'use strict';

const updateValidate = require('../update/validate')
  ;


/**
 * Validate document to patch
 * @param {any} doc
 * @returns null if validation fails
 */
function validate (opCtx, doc, storageDoc) {

  return updateValidate(opCtx, doc, storageDoc, { isPatching: true });
}

module.exports = validate;