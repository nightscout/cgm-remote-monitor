'use strict';

const utils = require('./utils')
  , _ = require('lodash')
  ;


/**
 * Find single document by identifier
 * @param {Object} col
 * @param {string} identifier
 * @param {Object} projection
 */
function findOne (col, identifier, projection) {

  return new Promise(function (resolve, reject) {

    const filter = utils.filterForOne(identifier);

    col.find(filter)
      .project(projection)
      .sort({ identifier: -1 }) // document with identifier first (not the fallback one)
      .toArray(function mongoDone (err, result) {

        if (err) {
          reject(err);
        } else {
          _.each(result, utils.normalizeDoc);
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
 */
function findOneFilter (col, filter, projection) {

  return new Promise(function (resolve, reject) {

    col.find(filter)
      .project(projection)
      .sort({ identifier: -1 }) // document with identifier first (not the fallback one)
      .toArray(function mongoDone (err, result) {

        if (err) {
          reject(err);
        } else {
          _.each(result, utils.normalizeDoc);
          resolve(result);
        }
      });
  });
}


/**
 * Find many documents matching the filtering criteria
 */
function findMany (col, filterDef, sort, limit, skip, projection, onlyValid, logicalOperator = 'and') {

  return new Promise(function (resolve, reject) {

    const filter = utils.parseFilter(filterDef, logicalOperator, onlyValid);

    col.find(filter)
      .sort(sort)
      .limit(limit)
      .skip(skip)
      .project(projection)
      .toArray(function mongoDone (err, result) {

        if (err) {
          reject(err);
        } else {
          _.each(result, utils.normalizeDoc);
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