'use strict';

const apiConst = require('../const.json')
  , stringTools = require('./stringTools')
  , writeValidation = require('../../server/write-validation')
  , treatmentDuration = require('../../treatmentDuration')
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


// Include inputs from which the duration normaliser derives a duration.
// Unrelated patches still leave already-stored invalid records editable.
const DOMAIN_FIELDS = ['eventType', 'units', 'targetTop', 'targetBottom',
  'duration', 'durationInMilliseconds', 'endmills', 'mills', 'created_at', 'date'];

/**
 * Apply the WRITE_VALIDATION domain rules (lib/server/write-validation.js)
 * to a treatment about to be stored.
 * @param {Object} opCtx
 * @param {Object} doc - the document as sent (a patch: the fields sent)
 * @param {Object} options - storageDoc: the stored document a patch applies to
 * @returns {any} - string with error message if validation fails, true in case of success
 */
function validateDomain (opCtx, doc, options) {

  const { env, res, col } = opCtx;
  const { storageDoc } = options || {};
  const mode = writeValidation.mode(env);

  if (mode === 'off' || !col || col.colName !== 'treatments')
    return true;

  if (storageDoc && !DOMAIN_FIELDS.some(field => typeof(doc[field]) !== 'undefined'))
    return true;

  const target = Object.assign({}, storageDoc, doc);
  let problems = writeValidation.checkTreatment(target);

  if (target.eventType === 'Temporary Target'
    && !problems.some(problem => problem.rule === 'tt-duration')) {
    // Match update/replace's precedence: normalise the patch with its stored
    // fallback, then merge it. Normalising the merged document would let an
    // old endmills override a newly supplied duration (including a cancel).
    // Work on a copy so off/log keep their existing storage behavior.
    const normalized = Object.assign({}, doc);
    try {
      treatmentDuration.normalizeTreatmentDuration(normalized, storageDoc);
      Object.assign(target, normalized);
      problems = writeValidation.checkTreatment(target);
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      // A JSON object in a timestamp field can fail numeric coercion. Log
      // mode must report that problem rather than turn a POST into a 500.
      problems.push({rule: 'tt-duration', field: 'duration',
        message: 'duration cannot be derived from the supplied timestamps'});
    }
  }

  if (problems.length === 0) {
    if (mode === 'reject') {
      const units = target.units;
      writeValidation.normalizeUnits(target);
      // PATCH may omit eventType: use the merged record's type, and copy
      // only the canonical units back to the fields that will be persisted.
      if (target.units !== units) doc.units = target.units;
    }
    return true;
  }

  if (mode === 'log') {
    console.warn(writeValidation.logLine('API v3', target, problems));
    return true;
  }

  return sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST,
    'Temporary Target: ' + writeValidation.describe(problems));
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
 * API v3 addresses a record by `identifier`; `_id` is the storage key the
 * server assigns, so a body that carries one, in any form, is refused with
 * 400 and nothing is written (BF-170). Before, create stored a 24-hex `_id`
 * as a string and answered 500 for `{"$oid": ...}`. API v1 keeps its own
 * `_id` handling. Returns true when the request was refused.
 * @param {Object} doc
 * @param {Object} res
 */
function refuseClientId (doc, res) {
  if (!Object.prototype.hasOwnProperty.call(doc, '_id'))
    return false;
  sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_CLIENT_ID);
  return true;
}


/**
 * Validate identifier in the document
 * @param {Object} doc
 */
function resolveIdentifier (doc) {

  // A client may name the record with its own identifier; it is kept as sent
  // and is not logged (BF-186). One is computed only when none is sent.
  if (!doc.identifier) {
    doc.identifier = calculateIdentifier(doc);
  }
}


module.exports = {
  sendJSON,
  sendJSONStatus,
  validateCommon,
  validateDomain,
  calculateIdentifier,
  resolveIdentifier,
  refuseClientId
};
