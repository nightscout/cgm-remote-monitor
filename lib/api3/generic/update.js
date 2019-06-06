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
     * @param {string} identifier
     * @param {any} doc
     */
    function insert (identifier, doc, authorization) {

      var now = new Date;
      doc.identifier = identifier;
      doc.srvModified = now.getTime();
      doc.srvCreated = doc.srvModified;
      col.fallbackCreatedAt(app, doc);

      if (authorization && authorization.subject && authorization.subject.name) {
        doc.user = authorization.subject.name;
      }

      col.authorizers.create(req, res, async function authorized () {
        try {
          await col.storage.insertOne(doc);

          res.setHeader('Last-Modified', now.toUTCString())
          res.status(apiConst.HTTP.CREATED).send({ });
          col.autoPrune();
          ctx.bus.emit('data-received');

        } catch(err) {
          console.error(err);
          return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
        }
      });
    }


    /**
     * Replace existing document in the collection
     * @param {any} doc - new version of document to set
     * @param {any} storageDoc - old version of document (existing in the storage)
     */
    async function replace (identifier, doc, storageDoc, authorization) {

      try {
        var now = new Date;
        doc.identifier = identifier;
        doc.srvModified = now.getTime();
        doc.srvCreated = storageDoc.srvCreated || doc.srvModified;
        col.fallbackCreatedAt(app, doc);

        if (storageDoc.user) {
          doc.user = storageDoc.user;
        }
        else {
          if (authorization && authorization.subject && authorization.subject.name) {
            doc.user = authorization.subject.name;
          }
        }

        const matchedCount = await col.storage.replaceOne(identifier, doc);

        if (!matchedCount) 
          throw 'empty matchedCount';

        res.setHeader('Last-Modified', now.toUTCString());
        res.status(apiConst.HTTP.NO_CONTENT).send({ });
        col.autoPrune();
        ctx.bus.emit('data-received');

      } catch(err) {
        console.error(err);
        return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }


    async function update (authorization) {
      try {
        const doc = req.body;

        if (validate(doc) == null) 
          return;

        const identifier = req.params.identifier
          , identifyingFilter = col.storage.identifyingFilter(identifier);

        const result = await col.storage.findOneFilter(identifyingFilter, { });

        if (!result) 
          throw 'empty result';

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

          replace(identifier, doc, storageDoc, authorization);
        }
        else {
          insert(identifier, doc, authorization);
        }
      } catch (err) {
        console.error(err);
        return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }

    col.authorizers.update(req, res, update);
  }
}

module.exports = UpdateOperation;