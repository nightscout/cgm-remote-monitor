'use strict';

const utils = require('./utils')
  ;

/**
 * Insert single document
 * @param {Object} col
 * @param {Object} doc
 * @param {Object} options
 */
function insertOne (col, doc, options) {

  return new Promise(function (resolve, reject) {

    col.insertOne(doc, function mongoDone(err, result) {

      if (err) {
        reject(err);
      } else {
        const identifier = doc.identifier || result.insertedId.toString();

        if (!options || options.normalize !== false) {
          delete doc._id;
        }
        resolve(identifier);
      }
    });
  });
}


/**
 * Replace single document
 * @param {Object} col
 * @param {string} identifier
 * @param {Object} doc
 */
function replaceOne (col, identifier, doc) {

  return new Promise(function (resolve, reject) {

    const filter = utils.filterForOne(identifier);

    col.replaceOne(filter, doc, { upsert: true }, function mongoDone(err, result) {
      if (err) {
        reject(err);
      } else {
        resolve(result.matchedCount);
      }
    });
  });
}


/**
 * Update single document by identifier
 * @param {Object} col
 * @param {string} identifier
 * @param {object} setFields
 */
function updateOne (col, identifier, setFields) {

  return new Promise(function (resolve, reject) {

    const filter = utils.filterForOne(identifier);

    col.updateOne(filter, { $set: setFields }, function mongoDone(err, result) {
      if (err) {
        reject(err);
      } else {
        resolve({ updated: result.modifiedCount });
      }
    });
  });
}


/**
 * Permanently remove single document by identifier
 * @param {Object} col
 * @param {string} identifier
 */
function deleteOne (col, identifier) {

  return new Promise(function (resolve, reject) {

    const filter = utils.filterForOne(identifier);

    col.deleteOne(filter, function mongoDone(err, result) {
      if (err) {
        reject(err);
      } else {
        resolve({ deleted: result.deletedCount });
      }
    });
  });
}


/**
 * Permanently remove many documents matching any of filtering criteria
 */
function deleteManyOr (col, filterDef) {

  return new Promise(function (resolve, reject) {

    const filter = utils.parseFilter(filterDef, 'or');

    col.deleteMany(filter, function mongoDone(err, result) {
      if (err) {
        reject(err);
      } else {
        resolve({ deleted: result.deletedCount });
      }
    });
  });
}


module.exports = {
  insertOne,
  replaceOne,
  updateOne,
  deleteOne,
  deleteManyOr
};
