'use strict';

// API v1's reads through the storage interface.
//
// The v1 storage modules (entries, treatments, devicestatus, profile, food,
// activity) read through api3's MongoCollection -- findFiltered -- instead of
// building driver cursors themselves. Their filters are still built exactly as
// before, by lib/server/query.js and each module's query_for; what changes is
// that the result is carried to the driver as a filter AST in the API v1
// dialect of lib/storage/filter.js, which reproduces the query document
// operand for operand. So MongoDB receives the same filter, sort, limit and
// read options it did, and a request gets the same answer.
//
// Writes are not here: they stay on each module's write-step handle (ST-WRITES).

const MongoCollection = require('../api3/storage/mongoCollection');
const filter = require('../storage/filter');
const allowlist = require('./query-operator-allowlist');
const countParam = require('./count');

const V1 = Object.freeze({ v1: true });

/**
 * The interface over one collection, acquired per call as each module's api()
 * is, so a store swapped under a running server (tests do this) is the one
 * read. The index set is [] because bootevent owns v1's index pass.
 * @param {Object} ctx
 * @param {Object} env may be undefined (profile's storage is built without one)
 * @param {string} physical the collection name in MongoDB
 * @param {string} logical the v1 collection name
 */
function collection (ctx, env, physical, logical) {
  return new MongoCollection(ctx, env, physical, logical, [ ]);
}

/**
 * A v1 query document as a filter AST. A query the AST cannot carry is refused
 * the way lib/server/query-operator-allowlist.js refuses one -- a 400
 * MongoQueryValidationError naming the operator -- so every v1 endpoint
 * answers it as it answers a refused operator today, never as a 500. Today's
 * allowlist runs first and nothing it admits is refused here; this is the
 * guarantee for whatever changes next.
 * @param {Object} query
 */
function toFilter (query) {
  try {
    return filter.validate(filter.fromMongo(query, V1), V1);
  } catch (err) {
    if (err && err.name === 'MongoQueryValidationError') throw err;
    if (err && err.operator !== undefined) throw allowlist.refusal(err.operator, 'query');
    const refused = new Error('Query is not supported by the Nightscout API v1: ' + (err && err.message));
    refused.name = 'MongoQueryValidationError';
    refused.status = refused.statusCode = 400;
    throw refused;
  }
}

/**
 * The documents a v1 read returns, as `find(query, readOptions).sort(sort)`
 * followed by countParam.applyCount did: a count of zero reads nothing, a
 * count that is not a positive whole number sets no limit.
 * @param {MongoCollection} storage
 * @param {Object} query a v1 query document
 * @param {Object} opts { sort, count, readOptions }
 */
async function list (storage, query, opts) {
  const ast = toFilter(query);
  if (countParam.isZeroCount(opts.count)) return [ ];
  const limit = countParam.parseCount(opts.count);
  return find(storage, ast, { sort: opts.sort, limit: limit === null ? undefined : limit
    , readOptions: opts.readOptions });
}

/**
 * findFiltered in the v1 dialect, returning documents exactly as stored
 * (normalize: false: API v1 returns _id).
 * @param {MongoCollection} storage
 * @param {Object} ast from toFilter
 * @param {Object} opts { sort, limit, readOptions }
 */
function find (storage, ast, opts) {
  return storage.findFiltered(ast, Object.assign({ }, opts, { v1: true, options: { normalize: false } }));
}

module.exports = { collection, toFilter, list, find };
