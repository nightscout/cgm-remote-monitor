'use strict';

const writeStep = require('../../../storage/write-step');
const { requireTenant } = require('../../../storage/tenant-scope');

/**
 * Storage implementation using mongoDB
 * @param {Object} ctx
 * @param {Object} env
 * @param {string} storageColName - physical collection name in MongoDB
 * @param {string} colName - logical API collection used for validation and events
 * @param {Array} indexedFields - indexes this storage ensures; defaults to API
 *   v3's set (MongoCollection.indexedFields)
 * @param {Object} context - who is writing: { source, validated }. `source`
 *   labels every write this storage makes (MongoCollection.SOURCES; API v3's
 *   own storage is the default, 'v3'). `validated: true` says the caller has
 *   already applied the socket's domain validation (see write-step). Other
 *   keys are not passed on: an origin label (which client or process) is a
 *   later, separate field of this object.
 */
function MongoCollection (ctx, env, storageColName, colName = storageColName, indexedFields, context) {

  const self = this
    , utils = require('./utils')
    , find = require('./find')
    , modify = require('./modify')
    ;

  self.colName = storageColName;

  // Storage overrides must not rename the resource used by domain rules/events.
  //
  // The handle is deliberately NOT a member of `self`. Every operation goes
  // through find.js / modify.js, and every write those make goes through this
  // write-step proxy, so a caller holding a storage object cannot reach past
  // the interface into the driver. No caller read `self.col` (lib/ and tests/
  // searched), so this is a visibility change only.
  const source = (context && context.source) || MongoCollection.SOURCES.V3;
  if (!Object.values(MongoCollection.SOURCES).includes(source)) {
    throw new TypeError('Unknown storage write source: ' + source);
  }
  const writeContext = {name: colName, source: source, env: env, bus: ctx.bus};
  if (context && context.validated) writeContext.validated = true;
  const col = writeStep.collection(ctx.store.collection(storageColName), writeContext);

  // Boot requests v3's set too (lib/server/bootevent.js), so on a running
  // server this finds them already in place. API v1 collections declare their
  // own set and must not silently acquire v3's, so the set is a parameter:
  // constructing this storage from a v1 module cannot change which indexes
  // exist on its collection. An empty list skips the call, which is what a v1
  // module passes while bootevent still owns its index pass. The default is
  // unchanged.
  const fieldsToIndex = indexedFields || MongoCollection.indexedFields;
  if (fieldsToIndex.length) {
    ctx.store.ensureIndexes(col, fieldsToIndex);
  }


  // Every operation that touches documents passes here, which makes this the
  // one place a read can assert the tenant binding (lib/storage/tenant-scope.js;
  // writes assert it again in the write step). Under `nightscout single` the
  // assertion returns at once and changes nothing. The operation is named so a
  // multitenant throw points at a call site.
  function guard (name, operation) {
    return function tenantBound (...args) {
      requireTenant(colName + '.' + name);
      return operation(...args);
    };
  }

  self.identifyingFilter = utils.identifyingFilter;

  self.findOne = guard('findOne', (...args) => find.findOne(col, ...args));

  self.findEveryForm = guard('findEveryForm', (...args) => find.findEveryForm(col, ...args));

  self.findOneFilter = guard('findOneFilter', (...args) => find.findOneFilter(col, ...args));

  self.findMany = guard('findMany', (...args) => find.findMany(col, ...args));

  self.insertOne = guard('insertOne', (...args) => modify.insertOne(col, ...args));

  self.replaceOne = guard('replaceOne', (...args) => modify.replaceOne(col, ...args));

  self.updateOne = guard('updateOne', (...args) => modify.updateOne(col, ...args));

  self.deleteOne = guard('deleteOne', (...args) => modify.deleteOne(col, ...args));

  self.updateEveryForm = guard('updateEveryForm', (...args) => modify.updateEveryForm(col, ...args));

  self.deleteEveryForm = guard('deleteEveryForm', (...args) => modify.deleteEveryForm(col, ...args));

  self.deleteManyOr = guard('deleteManyOr', (...args) => modify.deleteManyOr(col, ...args));

  // The storage interface beyond API v3's own needs: each takes a filter AST
  // node (lib/storage/filter.js) rather than a MongoDB query document, and each
  // is handed `col`, the write-step proxy, so every write still crosses the
  // persistence boundary. The API v1 modules, authorization storage and the
  // websocket read and write through these (lib/server/storage-reads.js).

  self.findFiltered = guard('findFiltered', (...args) => find.findFiltered(col, ...args));

  self.count = guard('count', (...args) => modify.count(col, ...args));

  self.insertMany = guard('insertMany', (...args) => modify.insertMany(col, ...args));

  self.deleteMany = guard('deleteMany', (...args) => modify.deleteMany(col, ...args));

  self.bulkUpsert = guard('bulkUpsert', (...args) => modify.bulkUpsert(col, ...args));

  self.updateMany = guard('updateMany', (...args) => modify.updateMany(col, ...args));

  self.replaceFiltered = guard('replaceFiltered', (...args) => modify.replaceFiltered(col, ...args));


  /**
   * Get server version
   */
  self.version = async function version () {

    const result = await ctx.store.db.admin().buildInfo();

    return {
      storage: 'mongodb',
      version: result.version
    };
  };


  /**
   * Get timestamp (e.g. srvModified) of the last modified document
   */
  self.getLastModified = async function getLastModified (fieldName) {

    // Was a hand-built cursor on the driver handle. findMany builds the same
    // cursor; `normalize: false` keeps the document exactly as stored, since
    // the old path never called normalizeDoc and
    // lib/api3/specific/lastModified.js reads the raw field.
    const [ result ] = await self.findMany({
      sort: { [fieldName]: -1 }
      , limit: 1
      , projection: { [fieldName]: 1 }
      , options: { normalize: false }
    });

    return result;
  }
}

// The write sources the persistence boundary (lib/storage/write-step.js) and
// its commit event know. The API v1 storage modules serve both the v1 routes
// and in-process writers (connectors, plugins), so they share one label.
MongoCollection.SOURCES = Object.freeze({
  V1: 'v1/internal'
  , V3: 'v3'
  , SOCKET: 'socket'
  , INTERNAL: 'internal'
});

MongoCollection.indexedFields = [ 'identifier',
  'srvModified',
  'isValid'
];

module.exports = MongoCollection;
