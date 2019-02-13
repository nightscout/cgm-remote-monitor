'use strict';

function configure (ctx, env, app) {
  var storageColBuilder = require('./storage/mongoCol')
    , wares = require('../middleware/')(env)

  /**
   * Builder of generic collection (abstraction over each collection specifics)
   * @param {any} colName - name of the collection inside the storage system
   */
  function build (colName, fallbackGetDate) {
    var col = { }
    
    col.colName = colName;
    col.fallbackGetDate = fallbackGetDate;
    col.storage = storageColBuilder(ctx, env, colName);

    col.opSearch = require('./operation/search')(ctx, env, app, col);
    col.opCreate = require('./operation/create')(ctx, env, app, col);
    col.opRead = require('./operation/read')(ctx, env, app, col);
    col.opUpdate = require('./operation/update')(ctx, env, app, col);
    col.opPatch = require('./operation/patch')(ctx, env, app, col);
    col.opDelete = require('./operation/delete')(ctx, env, app, col);
    col.opHistory = require('./operation/history')(ctx, env, app, col);

    col.mapRoutes = function mapRoutes () {
      var prefix = '/' + colName;
      var prefixId = prefix + '/:identifier';

      // GET /{collection}
      app.get(prefix, col.opSearch.operation);

      // POST /{collection}
      app.post(prefix, col.opCreate.operation);

      // GET /{collection}/history
      app.get(prefixId, col.opHistory.operation);

      // GET /{collection}/{identifier}
      app.get(prefixId, col.opRead.operation);

      // PUT /{collection}/{identifier}
      app.put(prefixId, col.opUpdate.operation);

      // PATCH /{collection}/{identifier}
      app.patch(prefixId, col.opPatch.operation);

      // DELETE /{collection}/{identifier}
      app.delete(prefixId, col.opDelete.operation);
    }


    /**
     * Floor date to whole seconds (cut off milliseconds)
     * @param {Date} date
     */
    col.floorSeconds = function floorSeconds (date) {
      var ms = date.getTime();
      ms -= ms % 1000;
      return new Date(ms);
    }


    return col;
  }

  return build;
}

module.exports = configure;