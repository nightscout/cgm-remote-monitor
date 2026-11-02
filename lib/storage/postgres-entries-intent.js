'use strict';

// Dormant v3 lab boundary. Route authorization, immutable/domain validation,
// current grants and cache/socket consumers are not implemented here.
const { isDeepStrictEqual } = require('node:util');
const { fromMongo, toMongo } = require('./filter');
const readEntries = require('./postgres-entries-read');
const writeEntries = require('./postgres-entries-write');
const intentStep = require('./write-intent');
const utils = require('../api3/storage/mongoCollection/utils');

const EMPTY_IDENTIFIER = { $in: [null, '', 0, false, NaN], $not: { $type: ['array', 'decimal'] } };

// Only this existing helper's BSON-only arms are reduced. Neither NaN nor
// Decimal128 can occur in the JSON document model; other queries still refuse.
function jsonFilter (filter) {
  if (filter === undefined || filter === null) return filter;
  if (typeof filter !== 'object' || Array.isArray(filter)) throw new TypeError('filter must be an object');
  const out = Object.create(null);
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or') {
      out[key] = Array.isArray(value) ? value.map(jsonFilter) : value;
    } else if (key === 'identifier' && isDeepStrictEqual(value, EMPTY_IDENTIFIER)) {
      out[key] = { $in: [null, '', 0, false], $not: { $type: 'array' } };
    } else out[key] = value;
  }
  return out;
}

function project (docs, projection) {
  if (!projection || !Object.keys(projection).length) return docs;
  const keys = Object.keys(projection);
  if (keys.some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ![0, 1].includes(projection[key]))) {
    throw new TypeError('PostgreSQL entries intent: unsupported projection');
  }
  const included = keys.filter(key => key !== '_id' && projection[key] === 1);
  const excluded = keys.filter(key => key !== '_id' && projection[key] === 0);
  if (included.length && excluded.length) throw new TypeError('PostgreSQL entries intent: mixed projection');
  const inclusion = included.length || (projection._id === 1 && !excluded.length);
  return docs.map(doc => {
    if (!inclusion) return Object.fromEntries(Object.entries(doc).filter(([key]) => projection[key] !== 0));
    const keep = new Set(included);
    if (projection._id !== 0) keep.add('_id');
    return Object.fromEntries(Object.entries(doc).filter(([key]) => keep.has(key)));
  });
}

module.exports = function postgresEntriesIntent ({ connection, table = 'entries', bus, env = {}, source = 'v3' } = {}) {
  if (source !== 'v3') throw new TypeError('PostgreSQL entries intent supports only the dormant v3 lab');
  if (!connection || typeof connection.transaction !== 'function') {
    throw new TypeError('PostgreSQL entries intent requires an owned commit boundary');
  }
  const reader = readEntries({ connection, table });
  const storage = Object.assign({}, reader, writeEntries({ connection, table }), {
    // The shared step uses v1 AST envelopes for its own identifying reads.
    // Translate only representable JSON predicates, not arbitrary v1 queries.
    async findFiltered (ast, opts = {}) {
      const { v1, projection, ...rest } = opts;
      const strict = v1 ? fromMongo(jsonFilter(toMongo(ast, { v1: true }))) : ast;
      // identifierHeldElsewhere reads only existence. Its chosen _id is not
      // exposed, so ordering that one-row probe does not change its answer.
      const existence = v1 && opts.limit === 1 && isDeepStrictEqual(projection, { _id: 1 });
      const docs = await reader.findFiltered(strict, {
        ...rest, ...(existence && !rest.sort ? { sort: { _id: 1 } } : {}), options: { normalize: false }
      });
      const shown = project(docs, projection);
      if (!opts.options || opts.options.normalize !== false) shown.forEach(utils.normalizeDoc);
      return shown;
    },
    async findOneFilter (filter, projection, options = {}) {
      if (Object.keys(options).some(key => !['normalize', 'limit'].includes(key))) {
        throw new TypeError('PostgreSQL entries intent: unsupported findOneFilter option');
      }
      const docs = await reader.findFiltered(fromMongo(jsonFilter(filter)), {
        sort: { identifier: -1, _id: -1 },
        limit: Number.isInteger(options.limit) && options.limit > 1 ? options.limit : 1,
        options: { normalize: false }
      });
      const shown = project(docs, projection);
      if (options.normalize !== false) shown.forEach(utils.normalizeDoc);
      return shown;
    }
  });
  const step = intentStep.forCollectionResolved(storage, 'entries', source, { env });
  return Object.assign({}, step, {
    async write (intent) {
      const written = await connection.transaction(() => step.write(intent));
      intentStep.emitIntentEvent(bus, written, { name: 'entries', source, op: intent && intent.op });
      return written;
    },
    settle (intent, stored, outcome, reason) {
      const written = step.settle(intent, stored, outcome, reason);
      intentStep.emitIntentEvent(bus, written, { name: 'entries', source, op: intent && intent.op });
      return written;
    }
  });
};
