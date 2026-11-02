// Read-only entries methods over PostgreSQL, mirroring the answers of
// lib/api3/storage/mongoCollection/find.js findFiltered/findOne and
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
const FIND_OPTIONS = new Set(['sort', 'limit', 'skip', 'projection', 'options', 'readOptions', 'v1']);
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
    if (!emptyProjection(o.projection)) throw unsupported('projection');
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
    const docs = rows.map(decodeDocument);
    if (!o.options || o.options.normalize !== false) docs.forEach(utils.normalizeDoc);
    return docs;
  }

  return {
    async findFiltered (ast, opts) {
      const o = opts || { };
      for (const key of Object.keys(o)) {
        if (!FIND_OPTIONS.has(key)) throw unsupported(`find option '${key}'`);
      }
      refuseCommon(o);
      return select(ast || null, o);
    }

    , async findOne (identifier, projection, options) {
      refuseCommon({ projection });
      return select(fromMongo(utils.filterForOne(identifier)), { sort: ONE_ORDER, limit: 1, options });
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
