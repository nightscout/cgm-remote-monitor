'use strict';

function configure (ctx, env, app) {
  var storageColBuilder = require('./storage/mongoCol')
    , wares = require('../middleware/')(env)

  /**
   * Builder of generic collection (abstraction over each collection specifics)
   * @param {any} colName - name of the collection inside the storage system
   */
  function build (colName) {
    var col = { }
    
    col.colName = colName;
    col.storage = storageColBuilder(ctx, env, colName);

    // implementation of operations can be easily switched in col object (if needed)
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
      app.get(prefix, wares.sendJSONStatus, function callSearch (req, res, next) {
        col.opSearch.operation(req, res, next);
      });

      // POST /{collection}
      app.post(prefix, wares.sendJSONStatus, function callCreate (req, res, next) {
        col.opCreate.operation(req, res, next);
      });

      // GET /{collection}/history
      app.get(prefixId, wares.sendJSONStatus, function callSearch (req, res, next) {
        col.opHistory.operation(req, res, next);
      });

      // GET /{collection}/{identifier}
      app.get(prefixId, wares.sendJSONStatus, function callRead (req, res, next) {
        col.opRead.operation(req, res, next);
      });

      // PUT /{collection}/{identifier}
      app.put(prefixId, wares.sendJSONStatus, function callUpdate (req, res, next) {
        col.opUpdate.operation(req, res, next);
      });

      // PATCH /{collection}/{identifier}
      app.patch(prefixId, wares.sendJSONStatus, function callPatch (req, res, next) {
        col.opPatch.operation(req, res, next);
      });

      // DELETE /{collection}/{identifier}
      app.delete(prefixId, wares.sendJSONStatus, function callDelete (req, res, next) {
        col.opDelete.operation(req, res, next);
      });
    }

    return col;
  }

  return build;
}

module.exports = configure;