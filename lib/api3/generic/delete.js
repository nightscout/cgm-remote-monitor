'use strict';

/**
  * DELETE: Deletes a document from the collection
  */
function DeleteOperation (ctx, env, app, col) {

  var self = this
    , apiConst = require('../const.json')

  self.col = col;

  self.operation = function operation (req, res) {
    
    function deletePermanently () {
      col.storage.deleteOne(req.params.identifier, function deleteOneDone (err, result) {
        if (err || !result) {
          console.error(err);
          return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
        }

        if (!result.deleted) {
          return res.sendJSONStatus(res, apiConst.HTTP.NOT_FOUND);
        }

        return res.sendJSONStatus(res, apiConst.HTTP.NO_CONTENT);
      });
    }


    function markAsDeleted () {
      var setFields = { 'isValid': false, 'srvModified': (new Date).getTime() };

      col.storage.updateOne(req.params.identifier, setFields, function updateOneDone (err, result) {
        if (err || !result) {
          console.error(err);
          return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
        }

        if (!result.updated) {
          return res.sendJSONStatus(res, apiConst.HTTP.NOT_FOUND);
        }

        return res.sendJSONStatus(res, apiConst.HTTP.NO_CONTENT);
      });
    }


    col.authBuilder.authorizerFor('api:' + col.colName + ':delete')(req, res, function() {

      if (req.query.permanent && req.query.permanent === "true") {
        deletePermanently();
      }
      else {
        markAsDeleted();
      }
    });
  }
}

module.exports = DeleteOperation;