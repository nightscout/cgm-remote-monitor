'use strict';

/**
  * READ: Retrieves a single document from the collection
  */
function ReadOperation (ctx, env, app, col) {

  var self = this
    , apiConst = require('../const.json')
    , FieldsProjector = require('./fieldsProjector')

  self.col = col;


  self.operation = function operation (req, res) {
    
    function loadFromDb () {
      var fieldsProjector = new FieldsProjector(req.query.fields);

      col.storage.findOne(req.params.identifier
        , fieldsProjector.storageProjection()
        , function findOneDone (err, result) {

        if (err || !result) {
          console.error(err);
          return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
        }

        if (result.length === 0) {
          return res.sendJSONStatus(res, apiConst.HTTP.NOT_FOUND);
        }

        var doc = result[0];
        if (doc.isValid === false) {
          return res.sendJSONStatus(res, apiConst.HTTP.GONE);
        }

        
        var modifiedDate = col.resolveDates(doc);
        if (modifiedDate) {
          res.setHeader('Last-Modified', modifiedDate.toUTCString())

          var ifModifiedSince = req.get('If-Modified-Since');

          if (ifModifiedSince 
            && col.floorSeconds(modifiedDate) <= col.floorSeconds(new Date(ifModifiedSince))) {
            return res.sendJSONStatus(res, apiConst.HTTP.NOT_MODIFIED);
          }
        }

        fieldsProjector.applyProjection(doc);

        res.status(apiConst.HTTP.OK).send(doc);
      });
    }

    col.authBuilder.authorizerFor('api:' + col.colName + ':read')(req, res, function authorized () {
      loadFromDb();
    });
  }
}

module.exports = ReadOperation;