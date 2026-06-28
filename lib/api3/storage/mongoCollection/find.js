'use strict';

const utils = require('./utils');

/**
 * Ensure Mongo limit/skip receive integers even when callers pass env strings.
 */
function toSafeInt (value, defaultValue) {
  if (value === null || value === undefined) {
    return defaultValue;
  }

  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function normalizeDocs (docs, options) {
  if (!options || options.normalize !== false) {
    docs?.forEach(utils.normalizeDoc);
  }

  return docs;
}


/**
 * Find single document by identifier
 * @param {Object} col
 * @param {string} identifier
 * @param {Object} projection
 * @param {Object} options
 */
async function findOne (col, identifier, projection, options) {

  const filter = utils.filterForOne(identifier);
  const result = await col.find(filter)
    .project(projection)
    .sort({ identifier: -1 }) // document with identifier first (not the fallback one)
    .toArray();

  return normalizeDocs(result, options);
}


/**
 * Find single document by query filter
 * @param {Object} col
 * @param {Object} filter specific filter
 * @param {Object} projection
 * @param {Object} options
 */
async function findOneFilter (col, filter, projection, options) {

  const result = await col.find(filter)
    .project(projection)
    .sort({ identifier: -1 }) // document with identifier first (not the fallback one)
    .toArray();

  return normalizeDocs(result, options);
}


/**
 * Find many documents matching the filtering criteria
 */
async function findMany (col, args) {
  const logicalOperator = args.logicalOperator || 'and';
  const filter = utils.parseFilter(args.filter, logicalOperator, args.onlyValid);
  const safeLimit = toSafeInt(args.limit, 1000);
  const safeSkip = toSafeInt(args.skip, 0);
  const result = await col.find(filter)
    .sort(args.sort)
    .limit(safeLimit)
    .skip(safeSkip)
    .project(args.projection)
    .toArray();

  return normalizeDocs(result, args.options);
}


module.exports = {
  findOne,
  findOneFilter,
  findMany
};
