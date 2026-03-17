'use strict';

const utils = require('./utils')
  , _ = require('lodash')
  ;

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


/**
 * Find single document by identifier
 * @param {Object} col
 * @param {string} identifier
 * @param {Object} projection
 * @param {Object} options
 */
function findOne (col, identifier, projection, options) {

  return new Promise(function (resolve, reject) {

    const filter = utils.filterForOne(identifier);

    col.find(filter)
      .project(projection)
      .sort({ identifier: -1 }) // document with identifier first (not the fallback one)
      .toArray(function mongoDone (err, result) {

        if (err) {
          reject(err);
        } else {
          if (!options || options.normalize !== false) {
            _.each(result, utils.normalizeDoc);
          }
          resolve(result);
        }
      });
  });
}


/**
 * Find single document by query filter
 * @param {Object} col
 * @param {Object} filter specific filter
 * @param {Object} projection
 * @param {Object} options
 */
function findOneFilter (col, filter, projection, options) {

  return new Promise(function (resolve, reject) {

    col.find(filter)
      .project(projection)
      .sort({ identifier: -1 }) // document with identifier first (not the fallback one)
      .toArray(function mongoDone (err, result) {

        if (err) {
          reject(err);
        } else {
          if (!options || options.normalize !== false) {
            _.each(result, utils.normalizeDoc);
          }
          resolve(result);
        }
      });
  });
}


/**
 * Find many documents matching the filtering criteria
 */
function findMany (col, args) {
  const logicalOperator = args.logicalOperator || 'and';
  return new Promise(function (resolve, reject) {

    const filter = utils.parseFilter(args.filter, logicalOperator, args.onlyValid);
    const safeLimit = toSafeInt(args.limit, 1000);
    const safeSkip = toSafeInt(args.skip, 0);

    col.find(filter)
      .sort(args.sort)
      .limit(safeLimit)
      .skip(safeSkip)
      .project(args.projection)
      .toArray(function mongoDone (err, result) {

        if (err) {
          reject(err);
        } else {
          if (!args.options || args.options.normalize !== false) {
            _.each(result, utils.normalizeDoc);
          }
          resolve(result);
        }
      });
  });
}


module.exports = {
  findOne,
  findOneFilter,
  findMany
};
