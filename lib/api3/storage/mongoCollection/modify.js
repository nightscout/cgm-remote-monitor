'use strict';

const assertNoQueryJavascript = require('../../../storage/assert-no-query-javascript');

const utils = require('./utils')
  , { toMongo } = require('../../../storage/filter')
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
 * no sort, so without this they could write the v1 record instead. Of two v1
 * copies stored by _id (the string and the ObjectId it names), reads and
 * writes take the ObjectId one: BSON orders ObjectId above String, and on
 * 15.0.8 and earlier the ObjectId copy is the one an edit wrote.
 * @param {Object} col
 * @param {string} identifier
 */
async function writeFilter (col, identifier) {

  const filter = utils.filterForOne(identifier);
  const target = await col.findOne(filter, { sort: { identifier: -1, _id: -1 }, projection: { _id: 1 } });

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
 * @param {object} [unsetFields] - fields to remove (a PATCH's nulls)
 */
async function updateOne (col, identifier, setFields, unsetFields) {

  const filter = await writeFilter(col, identifier);
  const update = { $set: setFields };
  if (unsetFields && Object.keys(unsetFields).length > 0) update.$unset = unsetFields;
  const result = await col.updateOne(filter, update);

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
 * Update every stored form of the document addressed by identifier: the v3
 * document with that identifier, a v1 record without an identifier whose _id
 * is the identifier, and both halves of such a record stored twice by _id (as
 * a string and as the ObjectId it names); see utils.filterForEveryForm. A
 * delete by identifier uses this, so it removes the record the way v1 DELETE
 * and the websocket dbRemove do, instead of leaving one form valid beside the
 * one it marked.
 * @param {Object} col
 * @param {string} identifier
 * @param {object} setFields
 */
async function updateEveryForm (col, identifier, setFields) {

  const result = await col.updateMany(utils.filterForEveryForm(identifier), { $set: setFields });

  return { updated: result.modifiedCount };
}


/**
 * Permanently remove every stored form of the document addressed by
 * identifier (see updateEveryForm)
 * @param {Object} col
 * @param {string} identifier
 */
async function deleteEveryForm (col, identifier) {

  const result = await col.deleteMany(utils.filterForEveryForm(identifier));

  return { deleted: result.deletedCount };
}


/**
 * Permanently remove many documents matching any of filtering criteria
 */
async function deleteManyOr (col, filterDef) {

  const filter = utils.parseFilter(filterDef, 'or');
  assertNoQueryJavascript(filter);
  const result = await col.deleteMany(filter);

  return { deleted: result.deletedCount };
}


/**
 * Insert many documents in one round trip.
 * Callers (ST-WRITES): lib/server/profile.js create, lib/server/devicestatus.js
 * create.
 * @param {Object} col
 * @param {Array} docs
 * @param {Object} options passed through to the driver (e.g. { ordered })
 */
async function insertMany (col, docs, options) {

  const result = await col.insertMany(docs, options);

  return { inserted: result.insertedCount, insertedIds: result.insertedIds };
}


/**
 * Permanently remove every document matching one filter.
 *
 * Distinct from deleteManyOr, which ORs a v3 filterDef array. This takes a
 * storage filter AST node (lib/storage/filter.js), since API v1 deletes by an
 * ordinary query rather than by a list of alternatives.
 *
 * Both spellings of the count, deliberately: `deleted` matches deleteManyOr's
 * contract, and `deletedCount` is what the API v1 delete endpoints put on the
 * wire (lib/api/shared/delete-status.js derives `n` from it). `acknowledged`
 * is the driver's own answer rather than a literal `true`, which would be
 * false under an unacknowledged write concern.
 *
 * @param {Object} col
 * @param {Object} filterAst a node from lib/storage/filter.js
 */
async function deleteMany (col, filterAst) {

  const filter = toMongo(filterAst);
  assertNoQueryJavascript(filter);
  const result = await col.deleteMany(filter);

  return { deleted: result.deletedCount, deletedCount: result.deletedCount
    , acknowledged: result.acknowledged };
}


/**
 * Count documents matching one filter.
 *
 * This is the whole of what lib/server/aggregate.js computes: its pipeline
 * extension points have no supplier, opts.pipeline is refused with 400 before
 * storage, and its terminal $group fixes _id to null. So the interface offers
 * count() and deliberately does NOT offer aggregate().
 *
 * @param {Object} col
 * @param {Object} filterAst a node from lib/storage/filter.js
 */
async function count (col, filterAst) {

  const filter = toMongo(filterAst);
  assertNoQueryJavascript(filter);

  return col.countDocuments(filter);
}


/**
 * Apply a field-level update to every document matching one filter.
 *
 * The capability lib/server/websocket.js needs that nothing else does (its
 * conversion is ST-WRITES): it edits and un-sets individual fields of an
 * existing document rather than replacing it. bulkUpsert cannot express
 * $unset, and replacing wholesale would destroy fields the client did not
 * send.
 *
 * `changes` is {set, unset}, both plain field maps. Field names are checked
 * here rather than trusted, because on the socket path they come straight off
 * the wire: a $-prefixed key in an update document is how a field name becomes
 * an update OPERATOR. MongoDB refuses most of these itself; this makes it
 * structural, the same argument as the filter AST.
 *
 * The update reaches the driver through `col`, the write-step proxy, so
 * treatments' conditional validated update (lib/storage/validated-update.js)
 * applies to it exactly as it does to every other updateMany.
 *
 * @param {Object} col
 * @param {Object} filterAst a node from lib/storage/filter.js
 * @param {Object} changes { set, unset }
 */
async function updateMany (col, filterAst, changes) {

  const filter = toMongo(filterAst);
  assertNoQueryJavascript(filter);

  const update = { };
  for (const key of ['set', 'unset']) {
    const fields = changes && changes[key];
    if (fields === undefined || fields === null) continue;
    if (typeof fields !== 'object' || Array.isArray(fields)) {
      throw new TypeError(`${key} must be an object`);
    }
    const names = Object.keys(fields);
    if (!names.length) continue;
    for (const name of names) {
      if (name.startsWith('$')) {
        throw new TypeError(`field name may not start with $: '${name}'`);
      }
      if (name.includes('\0')) throw new TypeError(`invalid field name '${name}'`);
    }
    update[key === 'set' ? '$set' : '$unset'] = fields;
  }

  if (!Object.keys(update).length) {
    throw new TypeError('updateMany requires a non-empty set or unset');
  }

  const result = await col.updateMany(filter, update);

  return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount
    , acknowledged: result.acknowledged };
}


/**
 * Replace a document in place, matched by filter, WITHOUT upserting.
 *
 * Distinct from replaceOne, which matches on an API v3 identifier and upserts,
 * and from bulkUpsert, which is upsert by definition. The socket path's profile
 * dedup (ST-WRITES) needs exactly this: it has already looked the document up,
 * and if that document was deleted in between, the write must do nothing
 * rather than resurrect a profile the user just removed.
 *
 * Returns matchedCount so a caller can tell "replaced" from "vanished", which
 * is the whole reason this is not an upsert.
 *
 * @param {Object} col
 * @param {Object} filterAst a node from lib/storage/filter.js
 * @param {Object} doc the replacement document
 */
async function replaceFiltered (col, filterAst, doc) {

  const filter = toMongo(filterAst);
  assertNoQueryJavascript(filter);

  const result = await col.replaceOne(filter, doc);

  return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount
    , acknowledged: result.acknowledged };
}


/**
 * Upsert many documents in one round trip, each matched by its own filter.
 *
 * `mode` preserves a real semantic difference between the existing callers and
 * must not be defaulted away:
 *   'replace' -- the stored document is replaced wholesale
 *                (treatments, food, activity)
 *   'merge'   -- $set, so stored fields absent from the incoming document
 *                survive (entries)
 * Any other mode is refused: a misspelt 'merge' that fell back to 'replace'
 * would destroy the stored fields 'merge' exists to keep.
 *
 * Returns upsertedIds keyed by the operation's index, because callers assign
 * the new _id back onto their input documents.
 *
 * @param {Object} col
 * @param {Array} ops [{ filter, doc }] -- filter is a storage filter AST node
 * @param {Object} options { mode = 'replace', ordered = true }
 */
async function bulkUpsert (col, ops, options) {

  const mode = (options && options.mode) || 'replace';
  if (mode !== 'replace' && mode !== 'merge') {
    throw new TypeError(`bulkUpsert mode must be 'replace' or 'merge', not '${mode}'`);
  }
  const ordered = !options || options.ordered !== false;

  const bulkOps = ops.map(function toBulkOp (op) {
    const filter = toMongo(op.filter);
    assertNoQueryJavascript(filter);

    return mode === 'merge'
      ? { updateOne: { filter, update: { $set: op.doc }, upsert: true } }
      : { replaceOne: { filter, replacement: op.doc, upsert: true } };
  });

  if (bulkOps.length === 0) {
    return { upsertedIds: { }, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }

  const result = await col.bulkWrite(bulkOps, { ordered });

  return {
    upsertedIds: result.upsertedIds || { }
    , matchedCount: result.matchedCount
    , modifiedCount: result.modifiedCount
    , upsertedCount: result.upsertedCount
  };
}


module.exports = {
  insertOne,
  insertMany,
  replaceOne,
  updateOne,
  deleteOne,
  updateEveryForm,
  deleteEveryForm,
  deleteMany,
  deleteManyOr,
  updateMany,
  replaceFiltered,
  count,
  bulkUpsert
};
