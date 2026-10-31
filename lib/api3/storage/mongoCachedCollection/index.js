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


  self.insertOne = async (doc) => {
    const result = await baseStorage.insertOne(doc, { normalize: false });

    if (cacheSupported()) {
      updateInCache([doc]);
    }

    if (doc._id) {
      delete doc._id;
    }
    return result;
  }


  // `storedId` (optional): the _id of the record to write, when the write
  // step picked one of several sharing the identifier (P4); the cache then
  // reads back that record.
  const writtenDocs = (identifier, storedId) => storedId === undefined
    ? baseStorage.findOne(identifier, null, { normalize: false })
    : baseStorage.findOneFilter({ _id: storedId }, null, { normalize: false });

  self.replaceOne = async (identifier, doc, ...storedId) => {
    const result = await baseStorage.replaceOne(identifier, doc, ...storedId);

    if (cacheSupported()) {
      const rawDocs = await writtenDocs(identifier, storedId[0])
      updateInCache([rawDocs[0]])
    }

    return result;
  }


  self.updateOne = async (identifier, setFields, unsetFields, ...storedId) => {
    const result = await baseStorage.updateOne(identifier, setFields, unsetFields, ...storedId);

    if (cacheSupported()) {
      const rawDocs = await writtenDocs(identifier, storedId[0])

      if (rawDocs[0].isValid === false) {
        deleteInCache(rawDocs)
      }
      else {
        updateInCache([rawDocs[0]])
      }
    }

    return result;
  }

  self.deleteOne = async (identifier) => {
    let invalidateDocs
    if (cacheSupported()) {
      invalidateDocs = await baseStorage.findOne(identifier, { _id: 1 }, { normalize: false })
    }

    const result = await baseStorage.deleteOne(identifier);

    if (cacheSupported()) {
      deleteInCache(invalidateDocs)
    }

    return result;
  }

  self.updateEveryForm = async (identifier, setFields) => {
    const result = await baseStorage.updateEveryForm(identifier, setFields);

    if (cacheSupported()) {
      const rawDocs = await baseStorage.findEveryForm(identifier, null, { normalize: false })

      if (rawDocs.every(function (doc) { return doc.isValid === false; })) {
        deleteInCache(rawDocs)
      }
      else {
        updateInCache(rawDocs)
      }
    }

    return result;
  }

  self.deleteEveryForm = async (identifier) => {
    let invalidateDocs
    if (cacheSupported()) {
      invalidateDocs = await baseStorage.findEveryForm(identifier, { _id: 1 }, { normalize: false })
    }

    const result = await baseStorage.deleteEveryForm(identifier);

    if (cacheSupported()) {
      deleteInCache(invalidateDocs)
    }

    return result;
  }

  self.deleteManyOr = async (filter) => {
    let invalidateDocs
    if (cacheSupported()) {
      invalidateDocs = await baseStorage.findMany({ filter,
        limit: 1000,
        skip: 0,
        projection: { _id: 1 },
        options: { normalize: false } });
    }

    const result = await baseStorage.deleteManyOr(filter);

    if (cacheSupported()) {
      deleteInCache(invalidateDocs)
    }

    return result;
  }

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

  function updateInCache (doc) {
    if (doc && doc.isValid === false) {
      deleteInCache([doc._id])
    }
    else {
      ctx.bus.emit('data-update', {
        type: colName
        , op: 'update'
        , changes: forCache(doc)
      });
    }
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
