'use strict';

// ID-BATCH (R1): the write step answers one item per document it was given
// (WriteResult.items, lib/storage/write-intent.js), and the storage modules
// answer their callers with the documents. This keeps each document's item
// beside the document, in a WeakMap, so an API v1 route can build its reply
// slot by slot from the step's per-item results without changing any storage
// callback, and without adding a member to a document a reply or the cache
// carries.

var items = new WeakMap();

/**
 * Keep each item of `result` beside the document at its index.
 * @param {Object[]} docs the documents the step was given, in order
 * @param {{ items?: Object[] }} result what the step answered
 */
function record (docs, result) {
  if (!Array.isArray(docs) || !result || !Array.isArray(result.items)) return;
  result.items.forEach(function each (item) {
    var doc = item && typeof item.index === 'number' ? docs[item.index] : undefined;
    if (doc && typeof doc === 'object') items.set(doc, item);
  });
}

/**
 * The step's item for a document, or undefined.
 * @param {Object} doc
 * @returns {Object|undefined}
 */
function of (doc) {
  return doc && typeof doc === 'object' ? items.get(doc) : undefined;
}

module.exports = { record: record, of: of };
