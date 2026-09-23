'use strict';

const idForms = require('../../../server/object-id-forms');


/**
 * Normalize document (make it mongoDB independent)
 * @param {Object} doc - document loaded from mongoDB
 */
function normalizeDoc (doc) {
  if (!doc.identifier) {
    doc.identifier = doc._id.toString();
  }

  delete doc._id;
}


/**
 * Parse filter definition array into mongoDB filtering object
 * @param {any} filterDef
 * @param {string} logicalOperator
 * @param {bool} onlyValid
 */
function parseFilter (filterDef, logicalOperator, onlyValid) {
  let filter = { };

  if (!filterDef)
    return filter;

  if (!Array.isArray(filterDef)) {
    return filterDef;
  }

  let clauses = [];

  for (const itemDef of filterDef) {
    if (!Object.prototype.hasOwnProperty.call(filter, itemDef.field)) {
      filter[itemDef.field] = {};
    }

    switch (itemDef.operator) {
      case 'eq':
        filter[itemDef.field]['$eq'] = itemDef.value;
        break;

      case 'ne':
        filter[itemDef.field]['$ne'] = itemDef.value;
        break;

      case 'gt':
        filter[itemDef.field]['$gt'] = itemDef.value;
        break;

      case 'gte':
        filter[itemDef.field]['$gte'] = itemDef.value;
        break;

      case 'lt':
        filter[itemDef.field]['$lt'] = itemDef.value;
        break;

      case 'lte':
        filter[itemDef.field]['$lte'] = itemDef.value;
        break;

      case 'in':
        filter[itemDef.field]['$in'] = itemDef.value.toString().split('|');
        break;

      case 'nin':
        filter[itemDef.field]['$nin'] = itemDef.value.toString().split('|');
        break;

      case 're':
        filter[itemDef.field]['$regex'] = itemDef.value.toString();
        break;

      default:
        throw new Error('Unsupported or missing filter operator ' + itemDef.operator);
    }

    if (logicalOperator === 'or') {
      clauses.push(filter);
      filter = { };
    }
  }

  if (logicalOperator === 'or') {
    filter = { $or: clauses };
  }

  if (onlyValid) {
    filter.isValid = { $ne: false };
  }

  return filter;
}


/**
 * Create query filter for single document with identifier fallback
 * @param {string} identifier
 */
function filterForOne (identifier) {

  const filterOpts = [ { identifier: { $eq: identifier } } ];

  // fallback to "identifier = _id". APIv1 may have stored the _id as the
  // 24-hex string rather than the ObjectId it names; match either, each
  // with literal equality.
  if (idForms.isHexId(identifier)) {
    idForms.idForms(identifier).forEach(function (form) {
      filterOpts.push({ _id: { $eq: form } });
    });
  } else if (typeof identifier === 'string') {
    // A v1 record whose _id is a string that is not 24-hex (a UUID stored by
    // treatments or entries up to 15.0.6, or a custom id kept by the
    // websocket) is listed with identifier = that _id; address it by it.
    filterOpts.push({ _id: { $eq: identifier } });
  }

  return { $or: filterOpts };
}


/**
 * Create query filter to check whether the document already exists in the storage.
 * This function resolves eventual fallback deduplication.
 * @param {string} identifier - identifier of document to check its existence in the storage
 * @param {Object} doc - document to check its existence in the storage
 * @param {Array} dedupFallbackFields - fields that all need to be matched to identify document via fallback deduplication
 * @returns {Object} - query filter for mongo or null in case of no identifying possibility
 */
function identifyingFilter (identifier, doc, dedupFallbackFields) {

  const filterItems = [];

  if (identifier) {
    // standard identifier field (APIv3)
    filterItems.push({ identifier: { $eq: identifier } });

    // fallback to "identifier = _id" (APIv1), with the _id stored either as
    // the ObjectId or as the 24-hex string
    if (idForms.isHexId(identifier)) {
      idForms.idForms(identifier).forEach(function (form) {
        filterItems.push({ identifier: { $exists: false }, _id: { $eq: form } });
      });
    } else if (typeof identifier === 'string') {
      // ...or with a non-hex string _id, as filterForOne
      filterItems.push({ identifier: { $exists: false }, _id: { $eq: identifier } });
    }
  }
  // let's deal with eventual fallback deduplication
  if (doc && Object.keys(doc).length > 0 && Array.isArray(dedupFallbackFields) && dedupFallbackFields.length > 0) {
    let dedupFilterItems = [];

    dedupFallbackFields.forEach(function addDedupField (field) {

      if (doc[field] !== undefined) {

        let dedupFilterItem = { };
        // `$eq` makes object-shaped client values literal data rather than a
        // nested query operator such as {$ne: null}.
        dedupFilterItem[field] = { $eq: doc[field] };
        dedupFilterItems.push(dedupFilterItem);
      }
    });

    if (dedupFilterItems.length === dedupFallbackFields.length) { // all dedup fields are present

      dedupFilterItems.push({ identifier: { $exists: false } }); // force not existing identifier for fallback deduplication
      filterItems.push({ $and: dedupFilterItems });
    }
  }

  if (filterItems.length > 0)
    return { $or: filterItems };
  else
    return null; // we don't have any filtering rule to identify the document in the storage
}


module.exports = {
  normalizeDoc,
  parseFilter,
  filterForOne,
  identifyingFilter
};
