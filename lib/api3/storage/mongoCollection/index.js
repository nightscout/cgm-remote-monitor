'use strict';

const writeStep = require('../../../storage/write-step');

/**
 * Storage implementation using mongoDB
 * @param {Object} ctx
 * @param {Object} env
 * @param {string} storageColName - physical collection name in MongoDB
 * @param {string} colName - logical API collection used for validation and events
 * @param {Array} indexedFields - indexes this storage ensures; defaults to API
 *   v3's set (MongoCollection.indexedFields)
 */
function MongoCollection (ctx, env, storageColName, colName = storageColName, indexedFields) {

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
  const col = writeStep.collection(ctx.store.collection(storageColName), {name: colName, source: 'v3', env: env, bus: ctx.bus});

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


  self.identifyingFilter = utils.identifyingFilter;

  self.findOne = (...args) => find.findOne(col, ...args);

  self.findEveryForm = (...args) => find.findEveryForm(col, ...args);

  self.findOneFilter = (...args) => find.findOneFilter(col, ...args);

  self.findMany = (...args) => find.findMany(col, ...args);

  self.insertOne = (...args) => modify.insertOne(col, ...args);

  self.replaceOne = (...args) => modify.replaceOne(col, ...args);

  self.updateOne = (...args) => modify.updateOne(col, ...args);

  self.deleteOne = (...args) => modify.deleteOne(col, ...args);

  self.updateEveryForm = (...args) => modify.updateEveryForm(col, ...args);

  self.deleteEveryForm = (...args) => modify.deleteEveryForm(col, ...args);

  self.deleteManyOr = (...args) => modify.deleteManyOr(col, ...args);

  // The storage interface beyond API v3's own needs: each takes a filter AST
  // node (lib/storage/filter.js) rather than a MongoDB query document, and each
  // is handed `col`, the write-step proxy, so every write still crosses the
  // persistence boundary. Nothing calls these yet; ST-READS and ST-WRITES move
  // the API v1 modules and the socket onto them.

  self.findFiltered = (...args) => find.findFiltered(col, ...args);

  self.count = (...args) => modify.count(col, ...args);

  self.insertMany = (...args) => modify.insertMany(col, ...args);

  self.deleteMany = (...args) => modify.deleteMany(col, ...args);

  self.bulkUpsert = (...args) => modify.bulkUpsert(col, ...args);

  self.updateMany = (...args) => modify.updateMany(col, ...args);

  self.replaceFiltered = (...args) => modify.replaceFiltered(col, ...args);


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

MongoCollection.indexedFields = [ 'identifier',
  'srvModified',
  'isValid'
];

module.exports = MongoCollection;
