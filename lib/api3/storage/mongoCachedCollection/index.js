'use strict';

/**
 * Storage implementation which wraps mongo baseStorage with caching
 * @param {Object} ctx
 * @param {Object} env
 * @param {string} colName - name of the collection in mongo database
 * @param {Object} baseStorage - wrapped mongo storage implementation
 */
function MongoCachedCollection (ctx, env, colName, baseStorage) {

  const self = this;

  self.colName = colName;

  self.identifyingFilter = baseStorage.identifyingFilter;

  self.findOne = (...args) => baseStorage.findOne(...args);

  self.findEveryForm = (...args) => baseStorage.findEveryForm(...args);

  self.findOneFilter = (...args) => baseStorage.findOneFilter(...args);

  self.findMany = (...args) => baseStorage.findMany(...args);


  /* Writes by identifier and API v3's prune (WC-STEP-PATCH release 2,
   * write-contract Q-A, Q-U). The write step (lib/storage/write-intent.js
   * forCollectionResolved) resolves each one to the _ids it will touch, writes
   * scoped to them through these methods, and tells the cache what it reached
   * with announce(); these methods no longer tell the cache anything
   * themselves. autoPrune's deleteManyOr is resolved in the step with the
   * delete's own OR (modify.js resolveOr), which keeps BF-222's fix: a record
   * that matches one condition only is named too.
   */
  for (const name of ['insertOne', 'replaceOne', 'updateOne', 'deleteOne', 'updateEveryForm', 'deleteEveryForm'
    , 'deleteManyOr', 'resolveOne', 'resolveEveryForm', 'resolveOr', 'findByIds']) {
    self[name] = (...args) => baseStorage[name](...args);
  }

  /**
   * Tell the in-memory cache what a write reached, by name: `updated` the
   * documents as stored now (one marked isValid: false is removed), `removed`
   * the _ids of the documents gone. `removed: null` is a write that could not
   * be named (over the step's resolve cap): the collection's cache reloads, as
   * a write by filter always did.
   */
  self.announce = function announce ({ updated, removed }) {
    if (!cacheSupported()) return;
    if (removed === null) {
      deleteInCache(undefined);
      return;
    }
    const gone = (removed || [ ]).map(String);
    const live = [ ];
    (updated || [ ]).forEach(function (doc) {
      if (!doc) return;
      if (doc.isValid === false) gone.push(String(doc._id));
      else live.push(doc);
    });
    if (gone.length) ctx.bus.emit('data-update', { type: colName, op: 'remove', changes: gone });
    if (live.length) ctx.bus.emit('data-update', { type: colName, op: 'update', changes: forCache(live) });
  };

  // The storage interface's filter-AST methods (lib/storage/filter.js). Reads
  // pass through. A write by filter can touch any number of documents, and
  // which ones is not known without a second read, so after it the cache drops
  // what it holds for this collection and reloads it (a 'remove' with no
  // changes; see lib/server/cache.js), the same as a v1 delete by query. The
  // API v1 modules and the socket do not use this wrapper: they announce their
  // own changes (lib/server/storage-writes.js).
  self.findFiltered = (...args) => baseStorage.findFiltered(...args);

  self.count = (...args) => baseStorage.count(...args);

  for (const name of ['insertMany', 'deleteMany', 'bulkUpsert', 'updateMany', 'replaceFiltered']) {
    self[name] = async (...args) => {
      try {
        return await baseStorage[name](...args);
      } finally {
        // Also after a failure: an unordered or partial write may have
        // committed some documents before it was refused.
        if (cacheSupported()) {
          deleteInCache(undefined);
        }
      }
    };
  }

  self.version = (...args) => baseStorage.version(...args);

  self.getLastModified = (...args) => baseStorage.getLastModified(...args);

  function cacheSupported () {
    return ctx.cache
      && ctx.cache[colName]
      && Array.isArray(ctx.cache[colName]);
  }

  /* Treatments and device status enter the cache with the fields the v1 paths
   * (lib/server/treatments.js, lib/server/devicestatus.js) derive on the way in
   * (ddata.processRawDataForRuntime: `mills` from created_at, `endmills` from a
   * duration). The dataloader sorts the treatments by `mills`, and the IOB and
   * COB plugins count only a treatment whose `mills` is before the time asked
   * about; GET /api/v1/devicestatus served from memory sorts by `mills`. Once
   * the cache is full enough the dataloader refetches only its most recent
   * minutes from MongoDB, so a record dated earlier than that (a late upload)
   * stays in memory as this copy.
   *
   * Nothing is stored: the helper derives on a copy. Entries are passed on as
   * before: every reader of cached entries takes their time from `date`.
   */
  const DERIVE_FOR_CACHE = { treatments: true, devicestatus: true };

  function forCache (docs) {
    return DERIVE_FOR_CACHE[colName] ? ctx.ddata.processRawDataForRuntime(docs) : docs;
  }

  function deleteInCache (docs) {
    let changes
    if (Array.isArray(docs)) {
      if (docs.length === 0) {
        return
      }
      else if (docs.length === 1 && docs[0]._id) {
        const _id = docs[0]._id.toString()
        changes = [ _id ]
      }
    }

    ctx.bus.emit('data-update', {
      type: colName
      , op: 'remove'
      , changes
    });
  }
}

module.exports = MongoCachedCollection;
