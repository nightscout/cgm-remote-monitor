'use strict';

const _ = require('lodash')
  , checkForHexRegExp = new RegExp("^[0-9a-fA-F]{24}$")
  , ObjectID = require('mongodb').ObjectID
;


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

  if (!_.isArray(filterDef)) {
    return filterDef;
  }

  let clauses = [];

  for (const itemDef of filterDef) {
    let item;

    switch (itemDef.operator) {
      case 'eq':
        item = itemDef.value;
        break;

      case 'ne':
        item = { $ne: itemDef.value };
        break;

      case 'gt':
        item = { $gt: itemDef.value };
        break;

      case 'gte':
        item = { $gte: itemDef.value };
        break;

      case 'lt':
        item = { $lt: itemDef.value };
        break;

      case 'lte':
        item = { $lte: itemDef.value };
        break;

      case 'in':
        item = { $in: itemDef.value.toString().split('|') };
        break;

      case 'nin':
        item = { $nin: itemDef.value.toString().split('|') };
        break;

      case 're':
        item = { $regex: itemDef.value.toString() };
        break;

      default:
        throw new Error('Unsupported or missing filter operator ' + itemDef.operator);
    }

    if (logicalOperator === 'or') {
      let clause = { };
      clause[itemDef.field] = item;
      clauses.push(clause);
    }
    else {
      filter[itemDef.field] = item;
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

  const filterOpts = [ { identifier } ];

  // fallback to "identifier = _id"
  if (checkForHexRegExp.test(identifier)) {
    filterOpts.push({ _id: ObjectID(identifier) });
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
    filterItems.push({ identifier: identifier });

    // fallback to "identifier = _id" (APIv1)
    if (checkForHexRegExp.test(identifier)) {
      filterItems.push({ identifier: { $exists: false }, _id: ObjectID(identifier) });
    }
  }

  // let's deal with eventual fallback deduplication
  if (!_.isEmpty(doc) && _.isArray(dedupFallbackFields) && dedupFallbackFields.length > 0) {
    let dedupFilterItems = [];

    _.each(dedupFallbackFields, function addDedupField (field) {

      if (doc[field] !== undefined) {

        let dedupFilterItem = { };
        dedupFilterItem[field] = doc[field];
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