'use strict';

/**
  * Generic collection (abstraction over each collection specifics)
  * @param {string} colName - name of the collection inside the storage system
  */
function Collection (ctx, env, app, authBuilder, colName, fallbackGetDate) {
  var self = this
    , CollectionStorage = require('./storage/mongoCollection')
    , SearchOperation = require('./operation/search')
    , CreateOperation = require('./operation/create')
    , ReadOperation = require('./operation/read')
    , UpdateOperation = require('./operation/update')
    , PatchOperation = require('./operation/patch')
    , DeleteOperation = require('./operation/delete')
    , HistoryOperation = require('./operation/history')
    
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
}

module.exports = Collection;