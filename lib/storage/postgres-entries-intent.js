'use strict';

// Dormant v3 commit boundary for lab and trusted tenant Collection composition.
// Route authorization, domain validation and current grants belong to callers.
const { isDeepStrictEqual } = require('node:util');
const { fromMongo, toMongo } = require('./filter');
const readEntries = require('./postgres-entries-read');
const writeEntries = require('./postgres-entries-write');
const intentStep = require('./write-intent');
const utils = require('../api3/storage/mongoCollection/utils');
const common = require('./postgres-intent-common');

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

module.exports = function postgresEntriesIntent ({ connection, table = 'entries', bus, env = {}, source = 'v3' } = {}) {
  if (source !== 'v3') throw new TypeError('PostgreSQL entries intent supports only dormant v3 operations');
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
      const shown = common.project(docs, projection, 'PostgreSQL entries intent');
      if (!opts.options || opts.options.normalize !== false) shown.forEach(utils.normalizeDoc);
      return shown;
    },
    findOneFilter: common.findOneFilter(reader, filter => fromMongo(jsonFilter(filter)), 'PostgreSQL entries intent')
  });
  const step = intentStep.forCollectionResolved(storage, 'entries', source, { env });
  return common.withCommitEvents(step, { connection, storage, bus, logical: 'entries', source });
};
