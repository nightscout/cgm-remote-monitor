'use strict';

const apiConst = require('../const.json')
  , stringTools = require('../shared/stringTools')
  , CollectionStorage = require('../storage/mongoCollection')
  , SearchOperation = require('./search')
  , CreateOperation = require('./create')
  , ReadOperation = require('./read')
  , UpdateOperation = require('./update')
  , PatchOperation = require('./patch')
  , DeleteOperation = require('./delete')
  , HistoryOperation = require('./history')
  ;

/**
  * Generic collection (abstraction over each collection specifics)
  * @param {string} colName - name of the collection inside the storage system
  * @param {function} fallbackGetDate - function that tries to create srvModified virtually from other fields of document
  * @param {Array} dedupFallbackFields - fields that all need to be matched to identify document via fallback deduplication
  * @param {function} fallbackHistoryFilter - function that creates storage filter for all newer records (than the timestamp from first function parameter)
  */
function Collection ({ ctx, env, app, authBuilder, colName, storageColName, fallbackGetDate, dedupFallbackFields,
    fallbackDateField }) {

  const self = this
    
  self.colName = colName;
  self.authBuilder = authBuilder;
  self.fallbackGetDate = fallbackGetDate;
  self.dedupFallbackFields = app.get('API3_DEDUP_FALLBACK_ENABLED') ? dedupFallbackFields : [];
  self.autoPruneDays = app.setENVTruthy('API3_AUTOPRUNE_' + colName.toUpperCase());
  self.nextAutoPrune = new Date();
  self.storage = new CollectionStorage(ctx, env, storageColName);
  self.fallbackDateField = fallbackDateField;

  self.authorizers = {
    create: authBuilder.authorizerFor(`api:${colName}:create`),
    read: authBuilder.authorizerFor(`api:${colName}:read`),
    update: authBuilder.authorizerFor(`api:${colName}:update`),
    delete: authBuilder.authorizerFor(`api:${colName}:delete`)
  }

  self.opSearch = new SearchOperation(ctx, env, app, self);
  self.opCreate = new CreateOperation(ctx, env, app, self);
  self.opRead = new ReadOperation(ctx, env, app, self);
  self.opUpdate = new UpdateOperation(ctx, env, app, self);
  self.opPatch = new PatchOperation(ctx, env, app, self);
  self.opDelete = new DeleteOperation(ctx, env, app, self);
  self.opHistory = new HistoryOperation(ctx, env, app, self);

  self.mapRoutes = function mapRoutes () {
    const prefix = '/' + colName
      , prefixId = prefix + '/:identifier'
      , prefixHistory = prefix + '/history'


    // GET /{collection}
    app.get(prefix, self.opSearch.operation);

    // POST /{collection}
    app.post(prefix, self.opCreate.operation);

    // GET /{collection}/history
    app.get(prefixHistory, self.opHistory.operation);

    // GET /{collection}/history
    app.get(prefixHistory + '/:lastModified', self.opHistory.operation);

    // GET /{collection}/{identifier}
    app.get(prefixId, self.opRead.operation);

    // PUT /{collection}/{identifier}
    app.put(prefixId, self.opUpdate.operation);

    // PATCH /{collection}/{identifier}
    app.patch(prefixId, self.opPatch.operation);

    // DELETE /{collection}/{identifier}
    app.delete(prefixId, self.opDelete.operation);
  }


  /**
    * Parse limit (max document count) from query string
    */
  self.parseLimit = function parseLimit (req, res) {
    const maxLimit = app.get('API3_MAX_LIMIT');
    let limit = maxLimit;

    if (req.query.limit) {
      if (!isNaN(req.query.limit) && req.query.limit > 0 && req.query.limit <= maxLimit) {
        limit = parseInt(req.query.limit);
      }
      else {
        res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_LIMIT);
        return null;
      }
    }

    return limit;
  }


  
  /**
    * Fetch modified date from document (with possible fallback and back-fill to srvModified/srvCreated) 
    * @param {any} doc - document loaded from database
    */
  self.resolveDates = function resolveDates (doc) {
    let modifiedDate;
    try {
      if (doc.srvModified) {
        modifiedDate = new Date(doc.srvModified);
      }
      else {
        if (typeof (self.fallbackGetDate) === 'function') {
          modifiedDate = self.fallbackGetDate(doc);
          if (modifiedDate) {
            doc.srvModified = modifiedDate.getTime();
          }
        }
      }

      if (doc.srvModified && !doc.srvCreated) {
        doc.srvCreated = modifiedDate.getTime();
      }
    }
    catch (error) {
      console.warn(error);
    }
    return modifiedDate;
  }


  /**
   * Deletes old documents from the collection if enabled (for this collection)
   * in the background (asynchronously)
   * */
  self.autoPrune = function autoPrune () {
    
    if (!stringTools.isNumberInString(self.autoPruneDays))
      return;
    
    const autoPruneDays = parseFloat(self.autoPruneDays);
    if (autoPruneDays <= 0) 
      return;

    if (new Date() > self.nextAutoPrune) {

      const deleteBefore = new Date(new Date().getTime() - (autoPruneDays * 24 * 3600 * 1000));

      const filter =  [
        { field: 'srvCreated', operator: 'lt', value: deleteBefore.getTime() },
        { field: 'created_at', operator: 'lt', value: deleteBefore.toISOString() },
        { field: 'date', operator: 'lt', value: deleteBefore.getTime() }
      ];

      // let's autoprune asynchronously (we won't wait for the result)
      self.storage.deleteManyOr(filter, function deleteDone (err, result) {
        if (err || !result) {
          console.error(err);
        }

        if (result.deleted) {
          console.info('Auto-pruned ' + result.deleted + ' documents from ' + self.colName + ' collection ');
        }
      });

      self.nextAutoPrune = new Date(new Date().getTime() + (1 * 3600 * 1000));
    }
  }


  /*
   * Eventually set the created_at field as a fallback mechanism
   * */
  self.fallbackCreatedAt = function fallbackCreatedAt (app, doc) {
    if (app.get('API3_CREATED_AT_FALLBACK_ENABLED') 
        && typeof(doc.created_at) === 'undefined'
        && typeof(doc.srvCreated) === 'number') {

      const srvCreated = new Date(doc.srvCreated);
      doc.created_at = srvCreated.toISOString();
    }
  }
}

module.exports = Collection;