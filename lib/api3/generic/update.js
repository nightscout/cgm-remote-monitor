'use strict';

/**
  * UPDATE: Updates a document in the collection
  */
function UpdateOperation (ctx, env, app, col) {

  var self = this
    , _ = require('lodash')
    , apiConst = require('../const.json')

  self.col = col;

  self.operation = function operation (req, res) {
   

    /**
     * Validate document to update
     * @param {any} doc
     * @returns null if validation fails
     */
    function validate (doc) {

      if (_.isEmpty(doc)) {
        res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_REQUEST_BODY);
        return null;
      }

      // TODO more validations

      return true;
    }


    /**
     * Insert new document into the collection
     * @param {string} identifier
     * @param {any} doc
     */
    function insert (identifier, doc) {

      var now = new Date;
      doc.identifier = identifier;
      doc.srvModified = now.getTime();
      doc.srvCreated = doc.srvModified;

      col.authBuilder.authorizerFor('api:' + col.colName + ':create')(req, res, function authorized () {

        col.storage.insertOne(doc, function insertDone (err) {

          if (err) {
            console.error(err);
            return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
          }

          res.setHeader('Last-Modified', now.toUTCString())
          res.status(apiConst.HTTP.CREATED).send({ });
          col.autoPrune();
        });    
      });
    }


    /**
     * Replace existing document in the collection
     * @param {any} doc - new version of document to set
     * @param {any} storageDoc - old version of document (existing in the storage)
     */
    function replace (identifier, doc, storageDoc) {

      var now = new Date;
      doc.identifier = identifier;
      doc.srvModified = now.getTime();
      doc.srvCreated = storageDoc.srvCreated || doc.srvModified;

      col.storage.replaceOne(identifier, doc, function replaceDone (err, matchedCount) {

        if (err || !matchedCount) {
          console.error(err);
          return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
        }

        res.setHeader('Last-Modified', now.toUTCString());
        res.status(apiConst.HTTP.NO_CONTENT).send({ });
        col.autoPrune();
      });
    }


    function update () {

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

            replace(identifier, doc, storageDoc);
          }
          else {
            insert(identifier, doc);
          }
      });
    }

    col.authBuilder.authorizerFor('api:' + col.colName + ':update')(req, res, function authorized () {

      update();
    });
  }
}

module.exports = UpdateOperation;