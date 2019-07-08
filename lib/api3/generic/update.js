'use strict';

const _ = require('lodash')
  , dateTools = require('../shared/dateTools')
  , apiConst = require('../const.json')

/**
  * UPDATE: Updates a document in the collection
  */
function UpdateOperation (ctx, env, app, col) {

  const self = this;
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

      if (!col.validateCommon(doc, res))
        return null;

      return true;
    }


    /**
     * Insert new document into the collection
     * @param {string} identifier
     * @param {any} doc
     */
    function insert (identifier, doc, authorization) {

      const now = new Date;
      doc.identifier = identifier;
      doc.srvModified = now.getTime();
      doc.srvCreated = doc.srvModified;

      if (authorization && authorization.subject && authorization.subject.name) {
        doc.subject = authorization.subject.name;
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
        const now = new Date;
        doc.identifier = identifier;
        doc.srvModified = now.getTime();
        doc.srvCreated = storageDoc.srvCreated || doc.srvModified;

        if (authorization && authorization.subject && authorization.subject.name) {
          doc.subject = authorization.subject.name;
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
        col.parseDate(doc);

        if (validate(doc) == null) 
          return;

        const identifier = req.params.identifier
          , identifyingFilter = col.storage.identifyingFilter(identifier);

        const result = await col.storage.findOneFilter(identifyingFilter, { });

        if (!result) 
          throw 'empty result';

        if (result.length > 0) {

          const storageDoc = result[0];
          if (storageDoc.isValid === false) {
            return res.status(apiConst.HTTP.GONE).end();
          }

          const modifiedDate = col.resolveDates(storageDoc)
            , ifUnmodifiedSince = req.get('If-Unmodified-Since');

          if (ifUnmodifiedSince 
            && dateTools.floorSeconds(modifiedDate) > dateTools.floorSeconds(new Date(ifUnmodifiedSince))) {
            return res.status(apiConst.HTTP.PRECONDITION_FAILED).end();
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