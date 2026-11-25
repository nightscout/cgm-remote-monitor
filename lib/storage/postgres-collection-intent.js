'use strict';

const { isDeepStrictEqual } = require('node:util');
const { fromMongo, toMongo } = require('./filter');
const read = require('./postgres-entries-read');
const write = require('./postgres-entries-write');
const intent = require('./write-intent');
const utils = require('../api3/storage/mongoCollection/utils');
const common = require('./postgres-intent-common');
const { followerEntries } = require('./postgres-follower-entries');
const READ_OPTIONS = require('./mongo-read-options');

const LOGICAL = new Set(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings']);
// Per-document filters one bulk read of a v1 batch carries (on-deleted's
// read, srv-dates carryForReplace). The api's data connection gives each
// statement 1 s (preview-api DATA_CONNECTION query_timeout), and such a
// statement costs PostgreSQL time in proportion to its filters: 288
// fallback-key treatments missed the deadline under seed load while 32 did
// not (R3, measured). MongoDB keeps its 500.
const FILTERS_PER_READ = 32;
const EMPTY_IDENTIFIER = { $in: [null, '', 0, false, NaN], $not: { $type: ['array', 'decimal'] } };

function uniqueMongo (filter) {
  if (!filter || typeof filter !== 'object') return false;
  if (Array.isArray(filter.$and) && filter.$and.some(uniqueMongo)) return true;
  return Object.entries(filter).some(([field, value]) => {
    if (value && Object.hasOwn(value, '$eq')) value = value.$eq;
    return field === '_id' && (typeof value === 'string' || value && value._bsontype === 'ObjectId')
      || field === 'identifier' && typeof value === 'string' && value.length > 0;
  });
}

function jsonFilter (filter) {
  if (filter === undefined || filter === null) return filter;
  if (typeof filter !== 'object' || Array.isArray(filter)) throw new TypeError('filter must be an object');
  const out = Object.create(null);
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or') {
      const children = Array.isArray(value) ? value.map(jsonFilter) : value;
      out[key] = key === '$and' && Array.isArray(children) ? (out[key] || []).concat(children) : children;
    } else if (key === 'identifier' && isDeepStrictEqual(value, EMPTY_IDENTIFIER)) {
      out[key] = { $in: [null, '', 0, false], $not: { $type: 'array' } };
    } else if (!key.startsWith('$') && value && Array.isArray(value.$in) &&
        value.$in.some(item => item instanceof RegExp)) {
      const { $in: values, ...other } = value;
      const scalars = values.filter(item => !(item instanceof RegExp));
      const choices = values.filter(item => item instanceof RegExp).map(item => ({ [key]: { $regex: item } }));
      if (scalars.length) choices.push({ [key]: { $in: scalars } });
      out.$and = (out.$and || []).concat({ $or: choices });
      if (Object.keys(other).length) out[key] = other;
    } else out[key] = value;
  }
  return out;
}

module.exports = function postgresCollectionIntent ({
  connection, table, logical, bus, env = {}, source = 'v3', naturalOrder = false, reader: suppliedReader, tieBreak, catalogue
} = {}) {
  if (!LOGICAL.has(logical) || !['v3', 'v1/internal', 'socket'].includes(source)) {
    throw new TypeError('PostgreSQL collection intent requires a trusted logical collection and source');
  }
  if (!connection || typeof connection.transaction !== 'function') {
    throw new TypeError('PostgreSQL collection intent requires an owned commit boundary');
  }
  // suppliedReader: the evaluator's in-process projection reads
  // (projection-memory-read.js), which answer as this reader does.
  // tieBreak: the evaluator's projection reads' total order (postgres-projection-read).
  const naturalTreatmentsOrder = naturalOrder === true && logical === 'treatments';
  const sealedDeviceStatus = logical === 'devicestatus' && require('./devicestatus-sealing').selected(catalogue);
  const reader = suppliedReader || read({ connection, table, sealedDeviceStatus, naturalOrder, tieBreak, legacyPatterns: source === 'v1/internal' || source === 'socket',
    keyOrder: naturalTreatmentsOrder, latestTimeDomain: source === 'v1/internal' ? logical : undefined });
  // INC-P: a treatments port over a table in insertion order (naturalOrder)
  // replaces, and answers an unsorted `_id` probe, as MongoDB does when a
  // filter reaches several rows: the earliest stored. INC-P2: an entries port
  // in insertion order merges a v1 re-send whose sysTime + type reaches
  // several entries into the earliest stored, as MongoDB's updateOne does.
  // Resend parity (2026-11-23): on treatments a fallback-key filter (created_at
  // and eventType pinned) takes MongoDB's index order instead, identifier and
  // date descending before insertion order (treatment-key-order.js), for the
  // replace, the server-date read and the reply's probe alike.
  const naturalTreatments = naturalTreatmentsOrder;
  const naturalEntries = naturalOrder === true && logical === 'entries';
  const writer = write({ connection, table, sealedDeviceStatus, legacyPatterns: source === 'v1/internal' || source === 'socket', windowDomain: logical,
    naturalReplace: naturalTreatments || naturalEntries, keyOrder: naturalTreatments });
  const translate = ast => fromMongo(jsonFilter(toMongo(ast, { v1: true })));
  function writeFilter (ast, opts = {}) {
    const { v1, one, ...rest } = opts;
    if (one) {
      const filter = toMongo(ast, { v1: !!v1 });
      if (!uniqueMongo(filter)) throw new TypeError('PostgreSQL collection intent: unsupported unsorted single-record filter');
    }
    return { ast: v1 ? translate(ast) : ast, opts: rest };
  }
  const storage = Object.assign({}, reader, writer, {
    filtersPerRead: FILTERS_PER_READ,
    ...(logical === 'entries' && source === 'v1/internal' && !suppliedReader && (table || logical).split('.').pop() === 'entries'
      ? { readFollowerEntries: followerEntries(connection, table || logical) } : {}),
    async findFiltered (ast, opts = {}) {
      const { v1, projection, readOptions, identitySet, ...rest } = opts;
      if (readOptions !== undefined && (!v1 || !isDeepStrictEqual(readOptions, READ_OPTIONS))) {
        throw new TypeError('PostgreSQL collection intent: unsupported driver read options');
      }
      const strict = v1 ? translate(ast) : ast;
      // Only a boolean existence probe is insensitive to the selected row.
      const existence = v1 && (opts.limit === 1 || identitySet === true)
        && isDeepStrictEqual(projection, { _id: 1 });
      const singleton = v1 && uniqueMongo(toMongo(strict));
      // INC-P: on treatments in insertion order an `_id` probe answers the
      // first record found, as MongoDB does (a re-send's reply names it), not
      // the lowest _id.
      const readOptionsResolved = {
        ...rest, ...((existence || singleton) && !rest.sort && !(v1 && naturalTreatments) ? { sort: { _id: 1 } } : {}), options: { normalize: false }
      };
      const docs = await (v1 && !readOptionsResolved.sort && naturalOrder === true
        ? reader.findNatural(strict, readOptionsResolved) : reader.findFiltered(strict, readOptionsResolved));
      const shown = common.project(docs, projection, 'PostgreSQL collection intent');
      if (!opts.options || opts.options.normalize !== false) shown.forEach(utils.normalizeDoc);
      return shown;
    },
    findOneFilter: common.findOneFilter(reader, filter => fromMongo(jsonFilter(filter)), 'PostgreSQL collection intent'),
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
  return common.withCommitEvents(step, { connection, storage, bus, logical, source, stampedV3Writes: true });
};
