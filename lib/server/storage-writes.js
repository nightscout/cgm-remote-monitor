'use strict';

// API v1's writes through the storage interface.
//
// The v1 storage modules, authorization storage and the websocket build their
// write filters and documents exactly as before; what changes is that each
// write reaches MongoDB through api3's MongoCollection, whose every write
// crosses the write-step proxy (lib/storage/write-step.js) under the source
// label the module acquired it with. Filters are carried as a filter AST in
// the API v1 dialect of lib/storage/filter.js, which reproduces the query
// document operand for operand, so MongoDB receives the same write.

const reads = require('./storage-reads');

const V1 = Object.freeze({ v1: true });

/**
 * deleteMany (or, with { one: true }, deleteOne) of a v1 query document.
 * Resolves to the driver's DeleteResult plus the interface's `deleted` alias.
 */
function remove (storage, query, opts) {
  return storage.deleteMany(reads.toFilter(query), Object.assign({ }, opts, V1));
}

/**
 * replaceOne(query, doc[, { upsert: true }]) of a v1 query document.
 */
function replace (storage, query, doc, opts) {
  return storage.replaceFiltered(reads.toFilter(query), doc, Object.assign({ }, opts, V1));
}

/**
 * updateMany (or, with { one: true }, updateOne) of a v1 query document with
 * the operators of `update`: only $set and $unset.
 */
function update (storage, query, changes, opts) {
  const keys = Object.keys(changes);
  if (keys.some(key => key !== '$set' && key !== '$unset')) {
    throw new TypeError('Only $set and $unset updates go through the storage interface');
  }
  return storage.updateMany(reads.toFilter(query), { set: changes.$set, unset: changes.$unset }
    , Object.assign({ }, opts, V1));
}

/**
 * An ordered bulkWrite of the operations the v1 modules build -- upserting
 * replaceOne, upserting updateOne ($set, $setOnInsert, $unset) and deleteMany
 * -- as one bulkUpsert, index for index, so upsertedIds name the same
 * operations. Resolves to bulkUpsert's reply ({ upsertedIds, ... }).
 */
function bulk (storage, bulkOps, options) {
  let mode;
  const ops = bulkOps.map(function toOp (op) {
    if (op.deleteMany) return { remove: reads.toFilter(op.deleteMany.filter) };
    const name = op.replaceOne ? 'replace' : op.updateOne ? 'merge' : null;
    const spec = op.replaceOne || op.updateOne;
    if (!name || mode && mode !== name || spec.upsert !== true) {
      throw new TypeError('Unsupported bulk operation for the storage interface');
    }
    mode = name;
    if (op.replaceOne) return { filter: reads.toFilter(spec.filter), doc: spec.replacement };
    const changes = spec.update;
    if (Object.keys(changes).some(key => ['$set', '$setOnInsert', '$unset'].indexOf(key) === -1)) {
      throw new TypeError('Unsupported bulk update for the storage interface');
    }
    return { filter: reads.toFilter(spec.filter), doc: changes.$set
      , setOnInsert: changes.$setOnInsert, unset: changes.$unset };
  });
  return storage.bulkUpsert(ops, Object.assign({ mode: mode || 'replace' }, options, V1));
}

module.exports = { remove, replace, update, bulk };
