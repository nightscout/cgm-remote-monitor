'use strict';

const utils = require('./utils');
const { toMongo } = require('../../../storage/filter');
const READ_OPTIONS = require('../../../storage/mongo-read-options');
const assertNoQueryJavascript = require('../../../storage/assert-no-query-javascript');

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
  assertNoQueryJavascript(filter);
  assertNoQueryJavascript({$expr: projection});
  const result = await col.find(filter)
    .project(projection)
    .sort({ identifier: -1, _id: -1 }) // document with identifier first (not the fallback one); of two copies stored by _id, the ObjectId one
    .limit(1)
    .toArray();

  return normalizeDocs(result, options);
}


/**
 * Find every stored form of the document addressed by identifier (see
 * modify.updateEveryForm)
 * @param {Object} col
 * @param {string} identifier
 * @param {Object} projection
 * @param {Object} options
 */
async function findEveryForm (col, identifier, projection, options) {

  const result = await col.find(utils.filterForEveryForm(identifier))
    .project(projection)
    .toArray();

  return normalizeDocs(result, options);
}


/**
 * Find single document by query filter
 * @param {Object} col
 * @param {Object} filter specific filter
 * @param {Object} projection
 * @param {Object} options { normalize, limit }: `limit` (a whole number over
 *   1; else 1) reads the first that many in the same order. API v3 PUT and
 *   PATCH read two, to see whether a second record shares the identifier
 *   (lib/storage/write-intent.js, 'v3-addressed').
 */
async function findOneFilter (col, filter, projection, options) {

  assertNoQueryJavascript(filter);
  assertNoQueryJavascript({$expr: projection});
  const limit = options && Number.isInteger(options.limit) && options.limit > 1 ? options.limit : 1;
  const result = await col.find(filter)
    .project(projection)
    .sort({ identifier: -1, _id: -1 }) // document with identifier first (not the fallback one); of two copies stored by _id, the ObjectId one
    .limit(limit)
    .toArray();

  return normalizeDocs(result, options);
}


/**
 * Find many documents matching the filtering criteria
 */
async function findMany (col, args) {
  const logicalOperator = args.logicalOperator || 'and';
  const filter = utils.parseFilter(args.filter, logicalOperator, args.onlyValid);
  assertNoQueryJavascript(filter);
  assertNoQueryJavascript({$expr: args.projection});
  const safeLimit = toSafeInt(args.limit, 1000);
  const safeSkip = toSafeInt(args.skip, 0);
  const result = await col.find(filter, READ_OPTIONS)
    .sort(args.sort)
    .limit(safeLimit)
    .skip(safeSkip)
    .project(args.projection)
    .toArray();

  return normalizeDocs(result, args.options);
}


/**
 * A cursor bound the caller asked for, as an integer. Unlike toSafeInt there is
 * no default to fall back to: MongoDB reads limit(0) as NO limit, so a limit
 * that does not parse must be refused rather than become an unbounded read.
 */
function cursorInt (name, value) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new TypeError(name + ' must be an integer');
  return parsed;
}


/**
 * Find documents matching a storage filter AST node.
 *
 * Distinct from findMany, which takes API v3's filterDef array. This is the
 * read API v1 needs: one filter expression, plus cursor options as arguments
 * rather than as a chained cursor, because a chained cursor is a driver object
 * and the interface must not hand one out.
 *
 * @param {Object} col
 * @param {Object} ast a node from lib/storage/filter.js, or null for unfiltered
 * @param {Object} opts { sort, limit, skip, projection, options, readOptions, v1 }
 *
 * `v1: true` reads `ast` in the API v1 dialect of lib/storage/filter.js, which
 * reproduces the query document API v1 built, operand for operand.
 *
 * `readOptions` is passed to the driver's find() as its second argument. API v1
 * uses it for lib/storage/mongo-read-options.js, which bounds getMore batch
 * size; dropping it would change how much a large report decodes at once.
 *
 * NOTE: `options.normalize` defaults to TRUE, matching findMany, which means
 * normalizeDoc moves _id into identifier and deletes _id. API v1 returns _id to
 * its clients, so every v1 caller MUST pass options: { normalize: false }.
 */
async function findFiltered (col, ast, opts) {

  const o = opts || { };
  const filter = ast ? toMongo(ast, { v1: o.v1 }) : { };
  assertNoQueryJavascript(filter);
  assertNoQueryJavascript({$expr: o.projection});

  let cursor = o.readOptions ? col.find(filter, o.readOptions) : col.find(filter);
  if (o.sort) cursor = cursor.sort(o.sort);
  if (o.skip) cursor = cursor.skip(cursorInt('skip', o.skip));
  if (o.limit !== undefined && o.limit !== null) cursor = cursor.limit(cursorInt('limit', o.limit));
  if (o.projection) cursor = cursor.project(o.projection);

  return normalizeDocs(await cursor.toArray(), o.options);
}


module.exports = {
  findFiltered,
  findOne,
  findEveryForm,
  findOneFilter,
  findMany
};
