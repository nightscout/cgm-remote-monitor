'use strict';

// Loop backfills are documented to use batches of up to 1,000 records. Keep
// ten times that capacity for other established clients while bounding the
// amount of per-request validation and storage work.
var MAX_BATCH_ITEMS = 10000;

function isDocument (value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(typeof Buffer !== 'undefined' && Buffer.isBuffer(value));
}

/**
 * Accept the legacy single-document and document-array write shapes.
 *
 * The size check deliberately happens before inspecting individual items, so
 * request-controlled arrays cannot cause unbounded validation work.
 *
 * @param {*} body parsed request body
 * @returns {{documents?: Array<object>, error?: string, invalidIndex?: number}}
 */
function normalize (body) {
  if (!Array.isArray(body) && !isDocument(body)) {
    return {error: 'shape'};
  }

  var documents = Array.isArray(body) ? body : [body];
  if (documents.length > MAX_BATCH_ITEMS) {
    return {error: 'size'};
  }

  var invalidIndex = documents.findIndex(function (document) {
    return !isDocument(document);
  });
  if (invalidIndex !== -1) {
    return {error: 'shape', invalidIndex: invalidIndex};
  }

  return {documents: documents};
}

module.exports = {
  MAX_BATCH_ITEMS: MAX_BATCH_ITEMS,
  isDocument: isDocument,
  normalize: normalize
};
