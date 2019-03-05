'use strict';

/**
  * Generic collection (abstraction over each collection specifics)
  * @param {string} colName - name of the collection inside the storage system
  */
function Collection (ctx, env, app, authBuilder, colName, fallbackGetDate) {
  var self = this
    , CollectionStorage = require('../storage/mongoCollection')
    , SearchOperation = require('./search')
    , CreateOperation = require('./create')
    , ReadOperation = require('./read')
    , UpdateOperation = require('./update')
    , PatchOperation = require('./patch')
    , DeleteOperation = require('./delete')
    , HistoryOperation = require('./history')
    
  self.colName = colName;
  self.authBuilder = authBuilder;
  self.fallbackGetDate = fallbackGetDate;
  self.storage = new CollectionStorage(ctx, env, colName);

  self.opSearch = new SearchOperation(ctx, env, app, self);
  self.opCreate = new CreateOperation(ctx, env, app, self);
  self.opRead = new ReadOperation(ctx, env, app, self);
  self.opUpdate = new UpdateOperation(ctx, env, app, self);
  self.opPatch = new PatchOperation(ctx, env, app, self);
  self.opDelete = new DeleteOperation(ctx, env, app, self);
  self.opHistory = new HistoryOperation(ctx, env, app, self);

  self.mapRoutes = function mapRoutes () {
    var prefix = '/' + colName;
    var prefixId = prefix + '/:identifier';

    // GET /{collection}
    app.get(prefix, self.opSearch.operation);

    // POST /{collection}
    app.post(prefix, self.opCreate.operation);

    // GET /{collection}/history
    app.get(prefixId, self.opHistory.operation);

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
    * Floor date to whole seconds (cut off milliseconds)
    * @param {Date} date
    */
  self.floorSeconds = function floorSeconds (date) {
    var ms = date.getTime();
    ms -= ms % 1000;
    return new Date(ms);
  }


  /**
    * Fetch modified date from document (with possible fallback and back-fill to srvModified/srvCreated) 
    * @param {any} doc - document loaded from database
    */
  self.resolveDates = function resolveDates(doc) {
    var modifiedDate;
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
}

module.exports = Collection;