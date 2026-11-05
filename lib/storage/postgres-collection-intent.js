'use strict';

const { isDeepStrictEqual } = require('node:util');
const { fromMongo, toMongo } = require('./filter');
const read = require('./postgres-entries-read');
const write = require('./postgres-entries-write');
const intent = require('./write-intent');
const utils = require('../api3/storage/mongoCollection/utils');
const READ_OPTIONS = require('./mongo-read-options');

const LOGICAL = new Set(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings']);
const EMPTY_IDENTIFIER = { $in: [null, '', 0, false, NaN], $not: { $type: ['array', 'decimal'] } };

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
    throw new TypeError('PostgreSQL collection intent: unsupported projection');
  }
  const included = keys.filter(key => key !== '_id' && projection[key] === 1);
  const excluded = keys.filter(key => key !== '_id' && projection[key] === 0);
  if (included.length && excluded.length) throw new TypeError('PostgreSQL collection intent: mixed projection');
  const inclusion = included.length || (projection._id === 1 && !excluded.length);
  return docs.map(doc => {
    if (!inclusion) return Object.fromEntries(Object.entries(doc).filter(([key]) => projection[key] !== 0));
    const keep = new Set(included);
    if (projection._id !== 0) keep.add('_id');
    return Object.fromEntries(Object.entries(doc).filter(([key]) => keep.has(key)));
  });
}

module.exports = function postgresCollectionIntent ({
  connection, table, logical, bus, env = {}, source = 'v3'
} = {}) {
  if (!LOGICAL.has(logical) || !['v3', 'v1/internal'].includes(source)) {
    throw new TypeError('PostgreSQL collection intent requires a trusted logical collection and source');
  }
  if (!connection || typeof connection.transaction !== 'function') {
    throw new TypeError('PostgreSQL collection intent requires an owned commit boundary');
  }
  const reader = read({ connection, table });
  const writer = write({ connection, table });
  const translate = ast => fromMongo(jsonFilter(toMongo(ast, { v1: true })));
  function writeFilter (ast, opts = {}) {
    const { v1, one, ...rest } = opts;
    if (one) {
      const filter = toMongo(ast, { v1: !!v1 });
      const unique = Object.entries(filter).some(([field, value]) =>
        (field === '_id' || field === 'identifier') && value !== null
        && (typeof value !== 'object' || value._bsontype === 'ObjectId'));
      if (!unique) throw new TypeError('PostgreSQL collection intent: unsupported unsorted single-record filter');
    }
    return { ast: v1 ? translate(ast) : ast, opts: rest };
  }
  const storage = Object.assign({}, reader, writer, {
    async findFiltered (ast, opts = {}) {
      const { v1, projection, readOptions, identitySet, ...rest } = opts;
      if (readOptions !== undefined && (!v1 || !isDeepStrictEqual(readOptions, READ_OPTIONS))) {
        throw new TypeError('PostgreSQL collection intent: unsupported driver read options');
      }
      const strict = v1 ? translate(ast) : ast;
      // Only a boolean existence probe is insensitive to the selected row.
      const existence = v1 && (opts.limit === 1 || identitySet === true)
        && isDeepStrictEqual(projection, { _id: 1 });
      const docs = await reader.findFiltered(strict, {
        ...rest, ...(existence && !rest.sort ? { sort: { _id: 1 } } : {}), options: { normalize: false }
      });
      const shown = project(docs, projection);
      if (!opts.options || opts.options.normalize !== false) shown.forEach(utils.normalizeDoc);
      return shown;
    },
    async findOneFilter (filter, projection, options = {}) {
      if (Object.keys(options).some(key => !['normalize', 'limit'].includes(key))) {
        throw new TypeError('PostgreSQL collection intent: unsupported findOneFilter option');
      }
      const docs = await reader.findFiltered(fromMongo(jsonFilter(filter)), {
        sort: { identifier: -1, _id: -1 },
        limit: Number.isInteger(options.limit) && options.limit > 1 ? options.limit : 1,
        options: { normalize: false }
      });
      const shown = project(docs, projection);
      if (options.normalize !== false) shown.forEach(utils.normalizeDoc);
      return shown;
    },
    count (ast, opts = {}) {
      const translated = writeFilter(ast, opts);
      return reader.count(translated.ast, translated.opts);
    },
    updateMany (ast, changes, opts) {
      const translated = writeFilter(ast, opts);
      return writer.updateMany(translated.ast, changes, translated.opts);
    },
    deleteMany (ast, opts) {
      const translated = writeFilter(ast, opts);
      return writer.deleteMany(translated.ast, translated.opts);
    },
    replaceFiltered (ast, doc, opts) {
      const translated = writeFilter(ast, opts);
      return writer.replaceFiltered(translated.ast, doc, translated.opts);
    },
    bulkUpsert (ops, opts = {}) {
      const { v1, ...rest } = opts;
      const translated = v1 ? ops.map(op => op.remove
        ? { ...op, remove: translate(op.remove) }
        : { ...op, filter: translate(op.filter) }) : ops;
      return writer.bulkUpsert(translated, rest);
    }
  });
  const step = intent.forCollectionResolved(storage, logical, source, { env });
  return Object.assign({}, step, {
    storage,
    async write (planned) {
      const written = await connection.transaction(() => step.write(planned));
      intent.emitIntentEvent(bus, written, { name: logical, source, op: planned && planned.op });
      return written;
    },
    settle (planned, stored, outcome, reason) {
      const written = step.settle(planned, stored, outcome, reason);
      intent.emitIntentEvent(bus, written, { name: logical, source, op: planned && planned.op });
      return written;
    }
  });
};
