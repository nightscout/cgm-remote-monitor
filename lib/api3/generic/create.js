'use strict';

/**
  * CREATE: Inserts a new document into the collection
  */
function CreateOperation (ctx, env, app, col) {

  var self = this
    , _ = require('lodash')
    , apiConst = require('../const.json')

  self.col = col;

  self.operation = function operation (req, res) {
    

    /**
     * Validate document to create
     * @param {any} doc
     * @returns null if validation fails
     */
    function validate (doc) {

      if (_.isEmpty(doc)) {
        res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_REQUEST_BODY);
        return null;
      }

      if (typeof(doc.identifier) !== 'string' || col.isNullOrWhitespace(doc.identifier)) {
        res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_FIELD_IDENTIFIER);
        return null;
      }

      if (typeof(doc.date) !== 'number' || doc.date <= apiConst.MIN_TIMESTAMP) {
        res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_FIELD_DATE);
        return null;
      }

      if (typeof(doc.app) !== 'string' || col.isNullOrWhitespace(doc.app)) {
        res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_FIELD_APP);
        return null;
      }

      return true;
    }


    /**
     * Insert new document into the collection
     * @param {any} doc
     */
    function insert (doc) {

      var now = new Date;
      doc.srvModified = now.getTime();
      doc.srvCreated = doc.srvModified;

      col.storage.insertOne(doc, function insertDone (err, identifier) {

        if (err || !identifier) {
          console.error(err);
          return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
        }

        res.setHeader('Last-Modified', now.toUTCString())
        res.setHeader('Location', req.originalUrl + '/' + identifier);
        res.status(apiConst.HTTP.CREATED).send({ });

        col.autoPrune();
        ctx.bus.emit('data-received');
      });    
    }


    /**
     * Replace (deduplicate) existing document in the collection
     * @param {any} doc - new version of document to set
     * @param {any} storageDoc - old version of document (existing in the storage)
     */
    function replace (doc, storageDoc) {

      var now = new Date;
      doc.srvModified = now.getTime();
      doc.srvCreated = storageDoc.srvCreated || doc.srvModified;

      col.authBuilder.authorizerFor('api:' + col.colName + ':update')(req, res, function authorized () {

        col.storage.replaceOne(storageDoc.identifier, doc, function replaceDone (err, matchedCount) {

          if (err || !matchedCount) {
            console.error(err);
            return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
          }

          var identifier = doc.identifier || storageDoc.identifier;

          res.setHeader('Last-Modified', now.toUTCString());
          res.setHeader('Location', req.originalUrl + '/' + identifier);
          res.status(apiConst.HTTP.NO_CONTENT).send({ });

          col.autoPrune();
          ctx.bus.emit('data-received');
        });
      });
    }


    function create () {

      var doc = req.body;

      if (validate(doc) == null) 
        return;

      var identifyingFilter = col.storage.identifyingFilter(doc.identifier, doc, col.dedupFallbackFields);

      col.storage.findOneFilter(identifyingFilter, { },
        function findOneFilterDone (err, result) {

          if (err || !result) {
            console.error(err);
            return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
          }

          if (result.length > 0) {
            replace(doc, result[0]);
          }
          else {
            insert(doc);
          }
      });
    }

    col.authBuilder.authorizerFor('api:' + col.colName + ':create')(req, res, function authorized () {

      create();
    });
  }
}

module.exports = CreateOperation;