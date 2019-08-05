'use strict';

const apiConst = require('../const.json')
  , stringTools = require('./stringTools')
  ;

function sendJSONStatus (res, status, title, description, warning) {

  const json = {
    status: status,
    message: title,
    description: description
  };

  // Add optional warning message.
  if (warning) { json.warning = warning; }

  res.status(status).json(json);

  return title;
}


/**
 * Validate document's common fields
 * @param {any} doc
 * @returns string with error message if validation fails, true in case of success
 */
function validateCommon (doc, res, options) {

  const { isPatching } = options || {};


  if ((!isPatching || typeof(doc.date) !== 'undefined')

    && (typeof(doc.date) !== 'number'
      || doc.date <= apiConst.MIN_TIMESTAMP)
  ) {
    return sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_FIELD_DATE);
  }


  if ((!isPatching || typeof(doc.utcOffset) !== 'undefined')

    && (typeof(doc.utcOffset) !== 'number'
      || doc.utcOffset < apiConst.MIN_UTC_OFFSET
      || doc.utcOffset > apiConst.MAX_UTC_OFFSET)
  ) {
    return sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_FIELD_UTC);
  }


  if ((!isPatching || typeof(doc.app) !== 'undefined')

    && (typeof(doc.app) !== 'string'
        || stringTools.isNullOrWhitespace(doc.app))
  ) {
    return sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_FIELD_APP);
  }

  return true;
}


module.exports = {
  sendJSONStatus,
  validateCommon
}