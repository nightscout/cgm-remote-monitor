'use strict';

// ID-UNIQUE-INDEX (maintainer, 2026-10-30): one partial unique index on
// `identifier` per collection, so no two stored records of a collection carry
// one identifier. Built at boot under WRITE_IDENTIFIER_INDEX
// (lib/server/write-settings.js):
//   try      build it where no stored duplicates block it; where they do, log
//            the counts per collection (never the values), show them on the
//            status page and run without it. The write step's identifier
//            matching still refuses a second record with a stored identifier.
//   require  as try, but a collection without the index stops the boot.
//   off      build nothing. An index already there stays; dropping it is the
//            operator's step (docs/architecture/write-intent.md, "The unique index on
//            `identifier`").
//
// Which records the index covers: those whose `identifier` is a non-empty
// string. Soft-deleted records (isValid: false) are covered too: a deleted
// identifier is acknowledged, never stored again. JSON null, an absent field,
// a number and the empty string are left out, as identifier-format treats
// them as absent; a sparse index, or a partial one without `$gt: ''`, would
// count each of those as a value and make every record without an identifier
// collide with the next. `$type` and `$gt` in a partial filter are accepted by
// MongoDB 5.0 (the floor) through 8.0, beside API v3's plain `identifier_1`.
//
// A stored `identifier` that is an array (written before identifier-format
// treated a non-string as absent, BF-215) is covered when any element is a
// non-empty string, and then EVERY element is an index key, an empty string,
// null or a number included (measured on 5.0.32 and 8.0.29): two such
// records collide on "" or null. So the duplicate count groups by element,
// as the index does, not by the whole value.
//
// MongoDB 4.2 and later build every index online (the collection stays
// readable and writable while it is built), so the build is a plain
// createIndex. Under `try` boot waits for it as long as for the other indexes
// and then carries on; under `require` it waits until it is built.
//
// With the index in place, two uploads of one record that race both miss the
// identifier match and both insert; the second gets a duplicate key, which the
// write step answers as a re-send (lib/storage/write-intent.js,
// DUPLICATE_IDENTIFIER). Without the index that error cannot arise, so the
// retry is inert.

const INDEX_NAME = 'identifier_unique';
const INDEX_KEY = Object.freeze({ identifier: 1 });
const PARTIAL_FILTER = Object.freeze({ identifier: Object.freeze({ $type: 'string', $gt: '' }) });

function indexOptions () {
  return { name: INDEX_NAME, unique: true
    , partialFilterExpression: { identifier: { $type: PARTIAL_FILTER.identifier.$type, $gt: PARTIAL_FILTER.identifier.$gt } } };
}

// A duplicate-key error raised by this index: a driver error with code 11000,
// or a bulk write error one of whose write errors is, that names the index or
// its key. A duplicate `_id` is not one.
function isDuplicateIdentifier (err) {
  if (!err) return false;
  const errors = [err].concat(Array.isArray(err.writeErrors) ? err.writeErrors : [ ]);
  return errors.some(function named (e) {
    if (!e || e.code !== 11000) return false;
    const keyPattern = e.keyPattern || (e.err && e.err.keyPattern);
    if (keyPattern) return Object.prototype.hasOwnProperty.call(keyPattern, 'identifier');
    const message = String(e.errmsg || e.message || (e.err && e.err.errmsg) || '');
    return message.indexOf(INDEX_NAME) !== -1;
  });
}

// The groups of records the index would refuse: each identifier held by more
// than one covered record, newest _id first. `limit` caps the groups read
// (undefined: all). Only the operator tool reads the values.
// The index's keys of each covered record: its identifier, or each element of
// an identifier array once.
const KEYS_OF_COVERED = Object.freeze([
  { $match: PARTIAL_FILTER }
  , { $unwind: '$identifier' }
  , { $group: { _id: { key: '$identifier', record: '$_id' } } }
]);

async function duplicateGroups (collection, limit) {
  const pipeline = KEYS_OF_COVERED.concat([
    { $group: { _id: '$_id.key', ids: { $push: '$_id.record' }, n: { $sum: 1 } } }
    , { $match: { n: { $gt: 1 } } }
    , { $sort: { _id: 1 } }
  ]);
  if (limit !== undefined) pipeline.push({ $limit: limit });
  return collection.aggregate(pipeline, { allowDiskUse: true }).toArray();
}

// How many identifiers (index keys) are each held by more than one covered
// record, and how many holdings there are (a record in two groups counts
// twice). Counts only.
async function duplicateCounts (collection) {
  const rows = await collection.aggregate(KEYS_OF_COVERED.concat([
    { $group: { _id: '$_id.key', n: { $sum: 1 } } }
    , { $match: { n: { $gt: 1 } } }
    , { $group: { _id: null, identifiers: { $sum: 1 }, records: { $sum: '$n' } } }
  ]), { allowDiskUse: true }).toArray();
  return rows.length ? { identifiers: rows[0].identifiers, records: rows[0].records } : { identifiers: 0, records: 0 };
}

// The index on `collection` named INDEX_NAME, or null. A collection that does
// not exist yet has none.
async function existingIndex (collection) {
  let indexes;
  try {
    indexes = await collection.indexes();
  } catch (err) {
    if (err && (err.code === 26 || err.codeName === 'NamespaceNotFound')) return null;
    throw err;
  }
  return indexes.find(function (index) { return index.name === INDEX_NAME; }) || null;
}

function sameDefinition (index) {
  const filter = index.partialFilterExpression && index.partialFilterExpression.identifier;
  return Boolean(index.unique) && JSON.stringify(index.key) === JSON.stringify(INDEX_KEY)
    && Boolean(filter) && filter.$type === PARTIAL_FILTER.identifier.$type && filter.$gt === PARTIAL_FILTER.identifier.$gt;
}

// One collection: its state ('present', 'built', 'blocked', 'failed') and,
// when blocked, the counts. Never throws.
async function ensureOne (collection) {
  try {
    const existing = await existingIndex(collection);
    if (existing) {
      if (sameDefinition(existing)) return { state: 'present' };
      return { state: 'failed', error: 'an index named ' + INDEX_NAME + ' exists with another definition' };
    }
    const counts = await duplicateCounts(collection);
    if (counts.identifiers > 0) return Object.assign({ state: 'blocked' }, counts);
    try {
      await collection.createIndex(INDEX_KEY, indexOptions());
    } catch (err) {
      // A duplicate stored between the count and the build.
      if (err && err.code === 11000) return Object.assign({ state: 'blocked' }, await duplicateCounts(collection));
      throw err;
    }
    return { state: 'built' };
  } catch (err) {
    return { state: 'failed', error: (err && (err.codeName || err.code)) ? String(err.codeName || err.code) : 'error' };
  }
}

// The log line for one collection that has no index. Counts only.
function describe (name, result) {
  if (result.state === 'blocked') {
    return 'identifier index on ' + name + ': ' + result.identifiers + ' identifier(s) are each held by more than one'
      + ' record (' + result.records + ' records); the collection runs without the unique index'
      + ' (tools/identifier-duplicates.js reports and resolves them)';
  }
  if (result.state === 'building') return 'identifier index on ' + name + ': still building; boot continues';
  return 'identifier index on ' + name + ': not built (' + result.error + ')';
}

/**
 * Build the index on each collection, as the mode says.
 * @param {{ name: string, collection: Object }[]} collections
 * @param {string} mode 'try' | 'require' | 'off'
 * @param {{ waitMs?: number, log?: Object }} [options] waitMs: how long `try`
 *   waits for the builds (default: no limit)
 * @returns {Promise<{ mode: string, ready: boolean, collections: Object, errors: string[] }>}
 *   `collections` maps each name to { state, identifiers?, records? };
 *   `errors` is what stops the boot under `require`.
 */
async function ensure (collections, mode, options) {
  const log = (options && options.log) || console;
  const status = { mode: mode, ready: false, collections: { }, errors: [ ] };
  if (mode === 'off') {
    collections.forEach(function (entry) { status.collections[entry.name] = { state: 'off' }; });
    return status;
  }
  const builds = collections.map(function (entry) {
    return ensureOne(entry.collection).then(function (result) { status.collections[entry.name] = result; });
  });
  const waitMs = options && options.waitMs;
  if (mode === 'try' && waitMs !== undefined) {
    let timer;
    await Promise.race([Promise.all(builds), new Promise(function (resolve) { timer = setTimeout(resolve, waitMs); })]);
    clearTimeout(timer);
  } else {
    await Promise.all(builds);
  }
  collections.forEach(function (entry) {
    if (!status.collections[entry.name]) status.collections[entry.name] = { state: 'building' };
  });
  status.ready = Object.keys(status.collections).every(function (name) {
    return ['present', 'built'].indexOf(status.collections[name].state) !== -1;
  });
  Object.keys(status.collections).forEach(function (name) {
    const result = status.collections[name];
    if (['present', 'built'].indexOf(result.state) !== -1) return;
    const line = describe(name, result);
    if (mode === 'require') status.errors.push(line);
    else log.warn(line);
  });
  return status;
}

// What the status page shows: the mode, whether every collection has the
// index, and per collection its state and, when blocked, the two counts.
function summary (status) {
  if (!status) return undefined;
  const collections = { };
  Object.keys(status.collections).forEach(function (name) {
    const result = status.collections[name];
    collections[name] = { state: result.state };
    if (result.state === 'blocked') {
      collections[name].duplicateIdentifiers = result.identifiers;
      collections[name].duplicateRecords = result.records;
    }
  });
  return { mode: status.mode, ready: status.ready, collections: collections };
}

module.exports = { ensure, summary, duplicateCounts, duplicateGroups, isDuplicateIdentifier, existingIndex
  , INDEX_NAME, INDEX_KEY, PARTIAL_FILTER, indexOptions };
