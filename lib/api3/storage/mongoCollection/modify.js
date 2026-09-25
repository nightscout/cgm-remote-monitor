'use strict';

const utils = require('./utils')
  ;

/**
 * Insert single document
 * @param {Object} col
 * @param {Object} doc
 * @param {Object} options
 */
async function insertOne (col, doc, options) {

  const result = await col.insertOne(doc);
  const identifier = doc.identifier || result.insertedId.toString();

  if (!options || options.normalize !== false) {
    delete doc._id;
  }

  return identifier;
}


/**
 * Filter that writes to the document a read by this identifier returns.
 * filterForOne can match two documents: a v1 record with no identifier whose
 * _id is the identifier, and a v3 document with that identifier (the copy a
 * v3 PUT left beside a string-_id record before either form was matched).
 * Reads sort the v3 document first; replaceOne, updateOne and deleteOne take
 * no sort, so without this they could write the v1 record instead.
 * @param {Object} col
 * @param {string} identifier
 */
async function writeFilter (col, identifier) {

  const filter = utils.filterForOne(identifier);
  const target = await col.findOne(filter, { sort: { identifier: -1 }, projection: { _id: 1 } });

  return target ? { _id: target._id } : filter;
}


/**
 * Replace single document
 * @param {Object} col
 * @param {string} identifier
 * @param {Object} doc
 */
async function replaceOne (col, identifier, doc) {

  const filter = await writeFilter(col, identifier);
  const result = await col.replaceOne(filter, doc, { upsert: true });

  return result.matchedCount;
}


/**
 * Update single document by identifier
 * @param {Object} col
 * @param {string} identifier
 * @param {object} setFields
 */
async function updateOne (col, identifier, setFields) {

  const filter = await writeFilter(col, identifier);
  const result = await col.updateOne(filter, { $set: setFields });

  return { updated: result.modifiedCount };
}


/**
 * Permanently remove single document by identifier
 * @param {Object} col
 * @param {string} identifier
 */
async function deleteOne (col, identifier) {

  const filter = await writeFilter(col, identifier);
  const result = await col.deleteOne(filter);

  return { deleted: result.deletedCount };
}


/**
 * Permanently remove many documents matching any of filtering criteria
 */
async function deleteManyOr (col, filterDef) {

  const filter = utils.parseFilter(filterDef, 'or');
  const result = await col.deleteMany(filter);

  return { deleted: result.deletedCount };
}


module.exports = {
  insertOne,
  replaceOne,
  updateOne,
  deleteOne,
  deleteManyOr
};
