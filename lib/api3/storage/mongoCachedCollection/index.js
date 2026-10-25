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


  self.replaceOne = async (identifier, doc) => {
    const result = await baseStorage.replaceOne(identifier, doc);

    if (cacheSupported()) {
      const rawDocs = await baseStorage.findOne(identifier, null, { normalize: false })
      updateInCache([rawDocs[0]])
    }

    return result;
  }


  self.updateOne = async (identifier, setFields) => {
    const result = await baseStorage.updateOne(identifier, setFields);

    if (cacheSupported()) {
      const rawDocs = await baseStorage.findOne(identifier, null, { normalize: false })

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
