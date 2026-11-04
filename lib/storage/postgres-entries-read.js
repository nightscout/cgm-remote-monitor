// Read-only entries methods over PostgreSQL, mirroring the answers of
// lib/api3/storage/mongoCollection/find.js findMany/findFiltered/findOne and
// modify.js count for the subset lib/storage/postgres-filter.js supports.
//
// Dormant: not registered as a storage backend, creates no schema and holds
// no write path. Every query goes through the tenant-bound transaction of
// lib/storage/postgres-connection.js, so an unbound caller is refused before
// SQL is sent, and rows are decoded by lib/storage/postgres-identity.js so an
// ObjectId _id and its same-spelling string stay distinct.

'use strict';

const { decodeDocument } = require('./postgres-identity');
const { fromMongo } = require('./filter');
const { compileFilter, compileSort, bound, Params, UnsupportedQueryError } = require('./postgres-filter');
const utils = require('../api3/storage/mongoCollection/utils');

const TABLE_PART = /^[a-z_][a-z0-9_]*$/;
const PROJECTION_PART = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIND_OPTIONS = new Set(['sort', 'limit', 'skip', 'projection', 'options', 'readOptions', 'v1']);
const FIND_MANY_ARGUMENTS = new Set(['filter', 'logicalOperator', 'onlyValid', 'sort', 'limit', 'skip', 'projection', 'options']);
// The order find.js findOne/findOneFilter read in: a record with its own
// identifier first, then of two copies stored by _id the ObjectId one.
const ONE_ORDER = { identifier: -1, _id: -1 };

function unsupported (message) {
  return new UnsupportedQueryError(message);
}

function emptyProjection (projection) {
  return projection === undefined || projection === null
    || (typeof projection === 'object' && !Array.isArray(projection) && !Object.keys(projection).length);
}

function projectionPaths (projection) {
  if (emptyProjection(projection)) return null;
  if (Object.getPrototypeOf(projection) !== Object.prototype) throw unsupported('projection');

  const entries = Object.entries(projection);
  for (const [field, include] of entries) {
    if (field.split('.').some(part => !PROJECTION_PART.test(part))
      || include !== 1) throw unsupported('projection');
  }

  return entries.map(([field]) => field);
}

function includePaths (value, paths) {
  if (Array.isArray(value)) return value.map(item => includePaths(item, paths));
  if (!value || typeof value !== 'object') return value;

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (paths.includes(key)) {
      result[key] = item;
      continue;
    }

    const nested = paths.filter(path => path.startsWith(key + '.'))
      .map(path => path.slice(key.length + 1));
    if (nested.length) result[key] = includePaths(item, nested);
  }
  return result;
}

function projectDocument (doc, projection) {
  const paths = projectionPaths(projection);
  if (!paths) return doc;

  const projected = includePaths(doc, paths.filter(field => field !== '_id'));
  if (Object.hasOwn(doc, '_id')) projected._id = doc._id;
  return projected;
}

module.exports = function postgresEntriesRead ({ connection, table = 'entries' } = {}) {
  if (!connection || typeof connection.query !== 'function') {
    throw new TypeError('PostgreSQL entries read requires a tenant-bound connection');
  }
  const parts = typeof table === 'string' ? table.split('.') : [];
  if (!parts.length || parts.length > 2 || !parts.every(part => TABLE_PART.test(part))) {
    throw new TypeError('PostgreSQL entries read requires a plain table name');
  }
  const from = parts.map(part => `"${part}"`).join('.');

  function refuseCommon (o) {
    if (o.v1) throw unsupported('API v1 dialect');
    if (o.readOptions !== undefined) throw unsupported('driver readOptions');
    projectionPaths(o.projection);
  }

  async function select (ast, o) {
    const params = new Params();
    const where = compileFilter(ast, params);
    const order = compileSort(o.sort, params);
    const limit = o.limit === undefined || o.limit === null ? 0 : bound('limit', o.limit);
    const skip = o.skip ? bound('skip', o.skip) : 0;
    // MongoDB's unsorted order is its storage order; a page of it has no
    // PostgreSQL equivalent, so a bounded read must say what it is ordered by.
    if (!order && (limit || skip)) throw unsupported('limit or skip without a sort');

    let text = `SELECT id_kind, doc${order && order.unsortable ? `, bool_or(${order.unsortable}) OVER () AS unsortable` : ''}` +
      ` FROM ${from} WHERE ${where}`;
    if (order) text += ` ORDER BY ${order.orderBy}`;
    if (limit) text += ` LIMIT ${params.add(limit)}`;
    if (skip) text += ` OFFSET ${params.add(skip)}`;

    const { rows } = await connection.query(text, params.values);
    // The window is computed over every matching row before LIMIT/OFFSET, so
    // any returned row reports an array or subdocument anywhere in the order.
    if (rows.length && rows[0].unsortable) throw unsupported('sort over an array or subdocument value');
    const docs = rows.map(row => projectDocument(decodeDocument(row), o.projection));
    if (!o.options || o.options.normalize !== false) docs.forEach(utils.normalizeDoc);
    return docs;
  }

  return {
    async findMany (args) {
      if (!args || Object.getPrototypeOf(args) !== Object.prototype ||
          Object.keys(args).some(key => !FIND_MANY_ARGUMENTS.has(key))) {
        throw unsupported('findMany arguments');
      }
      if (!Array.isArray(args.filter)) throw unsupported('findMany filter definition');
      if (args.filter.some(item => !item || typeof item !== 'object' || Array.isArray(item) ||
          typeof item.field !== 'string' || item.field === '__proto__')) {
        throw unsupported('findMany filter definition');
      }
      if (args.logicalOperator !== undefined && !['and', 'or'].includes(args.logicalOperator)) {
        throw unsupported('findMany logical operator');
      }
      if (args.onlyValid !== undefined && typeof args.onlyValid !== 'boolean') {
        throw unsupported('findMany validity filter');
      }
      if (!Number.isSafeInteger(args.limit) || args.limit < 1) {
        throw unsupported('findMany limit');
      }
      if (!Number.isSafeInteger(args.skip) || args.skip < 0) {
        throw unsupported('findMany skip');
      }
      if (args.sort === undefined || args.sort === null) throw unsupported('findMany sort');
      if (args.options !== undefined &&
          (!args.options || Object.getPrototypeOf(args.options) !== Object.prototype ||
            Object.keys(args.options).some(key => key !== 'normalize') ||
            (args.options.normalize !== undefined && typeof args.options.normalize !== 'boolean'))) {
        throw unsupported('findMany options');
      }

      const filter = utils.parseFilter(args.filter, args.logicalOperator || 'and', args.onlyValid);
      return select(fromMongo(filter), {
        sort: args.sort,
        limit: args.limit,
        skip: args.skip,
        projection: args.projection,
        options: args.options
      });
    }

    , async findFiltered (ast, opts) {
      const o = opts || { };
      for (const key of Object.keys(o)) {
        if (!FIND_OPTIONS.has(key)) throw unsupported(`find option '${key}'`);
      }
      refuseCommon(o);
      return select(ast || null, o);
    }

    , async findOne (identifier, projection, options) {
      refuseCommon({ projection });
      return select(fromMongo(utils.filterForOne(identifier)), { sort: ONE_ORDER, limit: 1, projection, options });
    }

    , async count (ast, opts) {
      const o = opts || { };
      if (o.v1) throw unsupported('API v1 dialect');
      const params = new Params();
      // modify.count passes its AST to toMongo, which refuses a missing filter.
      if (ast === null || ast === undefined) throw new TypeError('$: filter node must be an object');
      const where = compileFilter(ast, params);
      const { rows } = await connection.query(`SELECT count(*) AS n FROM ${from} WHERE ${where}`, params.values);
      return Number(rows[0].n);
    }
  };
};
