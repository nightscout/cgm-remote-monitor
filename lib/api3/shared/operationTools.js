'use strict';

const apiConst = require('../const.json')
  , stringTools = require('./stringTools')
  , {createHash} = require('node:crypto')
  , uuidNamespace = Buffer.from("NightscoutRocks!", "ascii") // persisted Nightscout namespace
  ;


function sendJSON ({ res, result, status, fields }) {

  const json = {
    status: status || apiConst.HTTP.OK,
    result: result
  };

  if (result) {
    json.result = result
  }

  if (fields) {
    Object.assign(json, fields);
  }

  res.status(json.status).json(json);
}


function sendJSONStatus (res, status, title, description, warning) {

  const json = {
    status: status
  };

  if (title) { json.message = title }

  if (description) { json.description = description }

  // Add optional warning message.
  if (warning) { json.warning = warning; }

  res.status(status)
    .json(json);

  return title;
}


/**
 * Validate document's common fields
 * @param {Object} doc
 * @param {any} res
 * @param {Object} options
 * @returns {any} - string with error message if validation fails, true in case of success
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


/**
 * Calculate identifier for the document
 * @param {Object} doc
 * @returns string
 */
function calculateIdentifier (doc) {
  if (!doc)
    return undefined;

  let key = doc.device + '_' + doc.date;
  if (doc.eventType) {
    key += '_' + doc.eventType;
  }

  // UUID v5: SHA-1(namespace bytes + UTF-8 name), then version/variant bits.
  // Keep rejection of lone surrogates; Buffer encoding would replace them.
  if (!key.isWellFormed()) throw new URIError('URI malformed');
  const bytes = createHash('sha1').update(uuidNamespace).update(key, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}


/**
 * Validate identifier in the document
 * @param {Object} doc
 */
function resolveIdentifier (doc) {

  let identifier = calculateIdentifier(doc);
  if (doc.identifier) {
    if (doc.identifier !== identifier) {
      console.warn(`APIv3: Identifier mismatch (expected: ${identifier}, received: ${doc.identifier})`);
      console.log(doc);
    }
  }
  else {
    doc.identifier = identifier;
  }
}


module.exports = {
  sendJSON,
  sendJSONStatus,
  validateCommon,
  calculateIdentifier,
  resolveIdentifier
};
