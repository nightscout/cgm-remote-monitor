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

const lateStamp = require('./late-stamp');

const { decodeDocument } = require('./postgres-identity');
const { fromMongo } = require('./filter');
const treatmentKeyOrder = require('./treatment-key-order');
const { compileFilter: strictFilter, compileSort, bound, Params, indexedColumns, UnsupportedQueryError } = require('./postgres-filter');
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

// A query has one projection, not one per returned row. Keep the prepared
// field paths local to that read; no request or document is retained.
function documentProjector (projection) {
  const paths = projectionPaths(projection);
  if (!paths) return doc => doc;
  const fields = paths.filter(field => field !== '_id');
  return doc => {
    const projected = includePaths(doc, fields);
    if (Object.hasOwn(doc, '_id')) projected._id = doc._id;
    return projected;
  };
}

function projectDocument (doc, projection) {
  return documentProjector(projection)(doc);
}

function refuseCommon (o) {
  if (o.v1) throw unsupported('API v1 dialect');
  if (o.readOptions !== undefined) throw unsupported('driver readOptions');
  projectionPaths(o.projection);
}

// Only the treatment catalogue and the evaluator projection select these terms.
const TIE_BREAKS = new Set(['insertion_ordinal', 'ordinal ASC NULLS LAST, id_kind COLLATE "C" ASC, "_id" COLLATE "C" ASC']);

// keyOrder (treatments, resend parity 2026-11-23): a natural read whose filter
// pins created_at and eventType answers in the order MongoDB's treatments
// index finds those rows (lib/storage/treatment-key-order.js).
module.exports = function postgresEntriesRead ({ connection, table = 'entries', naturalOrder = false, legacyPatterns = false, tieBreak, keyOrder = false } = {}) {
  if (tieBreak !== undefined && !TIE_BREAKS.has(tieBreak)) throw new TypeError('PostgreSQL entries read: unknown tie-break');
  const columns = indexedColumns(table);
  const compileFilter = (ast, params) => strictFilter(ast, params, { legacyPatterns, columns });
  if (!connection || typeof connection.query !== 'function') {
    throw new TypeError('PostgreSQL entries read requires a tenant-bound connection');
  }
  const parts = typeof table === 'string' ? table.split('.') : [];
  if (!parts.length || parts.length > 2 || !parts.every(part => TABLE_PART.test(part))) {
    throw new TypeError('PostgreSQL entries read requires a plain table name');
  }
  const from = parts.map(part => `"${part}"`).join('.');

  // Physical connections select the explicit read-only port. Query-only
  // projection facades keep the transaction owned by their source.
  function query (text, values) {
    return typeof connection.readOnlyTransaction === 'function'
      ? connection.readOnlyTransaction(() => connection.query(text, values))
      : connection.query(text, values);
  }

  async function select (ast, o, natural = false) {
    const params = new Params();
    const where = compileFilter(ast, params);
    const order = compileSort(o.sort, params);
    const limit = o.limit === undefined || o.limit === null ? 0 : bound('limit', o.limit);
    const skip = o.skip ? bound('skip', o.skip) : 0;
    // MongoDB's unsorted order is its storage order; a page of it has no
    // PostgreSQL equivalent, so a bounded read must say what it is ordered by.
    if (!order && !natural && (limit || skip)) throw unsupported('limit or skip without a sort');

    // A complete read returns every matching row, so a row-local sort guard
    // has exactly the same refusal behavior without a WindowAgg/materialization.
    // Pages still need the whole-set guard, including rows outside the page.
    const fullRead = !limit && !skip;
    const sortGuard = order && order.unsortable
      ? fullRead ? order.unsortable : `bool_or(${order.unsortable}) OVER ()` : null;
    let text = `SELECT id_kind, doc${sortGuard ? `, ${sortGuard} AS unsortable` : ''}` +
      ` FROM ${from} WHERE ${where}`;
    if (order) {
      text += ' ORDER BY ' + order.orderBy;
      if (tieBreak === 'insertion_ordinal') {
        // The storage-backed listing traverses created_at backwards. Cache loading
        // traverses it forwards, then stably sorts the records newest first.
        const newestFirst = o.sort.created_at === -1 && Object.keys(o.sort).length === 1;
        text += newestFirst ? ', insertion_ordinal DESC' : ', insertion_ordinal ASC';
      } else if (tieBreak) text += ', ' + tieBreak;
    } else if (natural) text += ' ORDER BY ' + (keyOrder && treatmentKeyOrder.applies(ast) ? treatmentKeyOrder.ORDER_BY : 'insertion_ordinal ASC');
    if (limit) text += ` LIMIT ${params.add(limit)}`;
    if (skip) text += ` OFFSET ${params.add(skip)}`;

    const { rows } = await query(text, params.values);
    // NS_CLOCK_LATE_STAMP: a read before the clock row is validated under it.
    lateStamp.recordRead(from, ast, rows);
    // The window is computed over every matching row before LIMIT/OFFSET, so
    // any returned row reports an array or subdocument anywhere in the order.
    if (rows.some(row => row.unsortable)) throw unsupported('sort over an array or subdocument value');
    // Preserve empty-result refusal behavior for findMany's legacy caller.
    const project = rows.length ? documentProjector(o.projection) : null;
    const docs = rows.map(row => project(decodeDocument(row)));
    if (!o.options || o.options.normalize !== false) docs.forEach(utils.normalizeDoc);
    return docs;
  }

  return {
    async findNatural (ast, opts = {}) {
      if (naturalOrder !== true || opts.sort) throw unsupported('natural insertion order');
      for (const key of Object.keys(opts)) {
        if (!FIND_OPTIONS.has(key)) throw unsupported(`find option '${key}'`);
      }
      refuseCommon(opts);
      return select(ast || null, opts, true);
    },

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
      const { rows } = await query(`SELECT count(*) AS n FROM ${from} WHERE ${where}`, params.values);
      lateStamp.recordRead(from, ast, []);
      return Number(rows[0].n);
    }
  };
};

// Shared with the evaluator's in-process projection reads (projection-memory-read.js).
module.exports.internals = Object.freeze({ projectDocument, documentProjector, refuseCommon });
