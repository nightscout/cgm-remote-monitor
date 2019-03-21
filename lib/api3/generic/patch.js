'use strict';

/**
  * PATCH: Partially updates document in the collection
  */
function PatchOperation (ctx, env, app, col) {

  var self = this
    , _ = require('lodash')
    , apiConst = require('../const.json')

  self.col = col;

  self.operation = function operation (req, res) {


    /**
     * Validate document to patch
     * @param {any} doc
     * @returns null if validation fails
     */
    function validate (doc) {

      if (_.isEmpty(doc)) {
        res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_REQUEST_BODY);
        return null;
      }

      if (doc.identifier !== undefined)
        delete doc.identifier;

      if (doc.srvModified !== undefined)
        delete doc.srvModified;

      if (doc.srvCreated !== undefined)
        delete doc.srvCreated;

      // TODO more validations

      return true;
    }


    /**
     * Patch existing document in the collection
     * @param {any} doc - fields and values to patch
     * @param {any} storageDoc - old version of document (existing in the storage)
     */
    function applyPatch (identifier, doc, storageDoc) {

      var now = new Date;
      doc.srvModified = now.getTime();

      col.storage.updateOne(identifier, doc, function updateOneDone (err, matchedCount) {

        if (err || !matchedCount) {
          console.error(err);
          return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
        }

        res.setHeader('Last-Modified', now.toUTCString());
        res.status(apiConst.HTTP.NO_CONTENT).send({ });
      });
    }


    function patch () {

      var doc = req.body;

      if (validate(doc) == null) 
        return;

      var identifier = req.params.identifier
        , identifyingFilter = col.storage.identifyingFilter(identifier);

      col.storage.findOneFilter(identifyingFilter, { },
        function findOneFilterDone (err, result) {

          if (err || !result) {
            console.error(err);
            return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
          }

          if (result.length > 0) {

            var storageDoc = result[0];
            if (storageDoc.isValid === false) {
              return res.sendJSONStatus(res, apiConst.HTTP.GONE);
            }

            var modifiedDate = col.resolveDates(storageDoc)
              , ifUnmodifiedSince = req.get('If-Unmodified-Since');

            if (ifUnmodifiedSince 
              && col.floorSeconds(modifiedDate) > col.floorSeconds(new Date(ifUnmodifiedSince))) {
              return res.sendJSONStatus(res, apiConst.HTTP.PRECONDITION_FAILED);
            }

            applyPatch(identifier, doc, storageDoc);
          }
          else {
            return res.sendJSONStatus(res, apiConst.HTTP.NOT_FOUND);
          }
      });
    }

    col.authBuilder.authorizerFor('api:' + col.colName + ':update')(req, res, function authorized () {

      patch();
    });
  }
}

module.exports = PatchOperation;