'use strict';

const _ = require('lodash')
  , apiConst = require('../const.json')
  , stringTools = require('../shared/stringTools')

/**
  * CREATE: Inserts a new document into the collection
  */
function CreateOperation (ctx, env, app, col) {

  const self = this;
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

      if (typeof(doc.identifier) !== 'string' || stringTools.isNullOrWhitespace(doc.identifier)) {
        res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_FIELD_IDENTIFIER);
        return null;
      }

      if (!col.validateCommon(doc, res))
        return null;

      return true;
    }


    /**
     * Insert new document into the collection
     * @param {any} doc
     */
    async function insert (doc, authorization) {

      try {
        const now = new Date;
        doc.srvModified = now.getTime();
        doc.srvCreated = doc.srvModified;

        if (authorization && authorization.subject && authorization.subject.name) {
          doc.subject = authorization.subject.name;
        }

        const identifier = await col.storage.insertOne(doc);

        if (!identifier) 
          throw 'empty identifier';

        res.setHeader('Last-Modified', now.toUTCString())
        res.setHeader('Location', `${req.baseUrl}${req.path}/${identifier}`);
        res.status(apiConst.HTTP.CREATED).send({ });

        ctx.bus.emit('storage-socket-create', { colName: col.colName, doc });
        col.autoPrune();
        ctx.bus.emit('data-received');

      } catch (err) {
        console.error(err);
        return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }


    /**
     * Replace (deduplicate) existing document in the collection
     * @param {any} doc - new version of document to set
     * @param {any} storageDoc - old version of document (existing in the storage)
     */
    function replace (doc, storageDoc, authorization) {

      try {
        const now = new Date;
        doc.srvModified = now.getTime();
        doc.srvCreated = storageDoc.srvCreated || doc.srvModified;

        if (storageDoc.subject) {
          doc.subject = storageDoc.subject;
        }
        else {
          if (authorization && authorization.subject && authorization.subject.name) {
            doc.subject = authorization.subject.name;
          }
        }

        col.authorizers.update(req, res, async function authorized () {

          const matchedCount = await col.storage.replaceOne(storageDoc.identifier, doc);

          if (!matchedCount) 
            throw 'empty matchedCount';

          const identifier = doc.identifier || storageDoc.identifier;

          res.setHeader('Last-Modified', now.toUTCString());
          res.setHeader('Location', req.originalUrl + '/' + identifier);
          res.status(apiConst.HTTP.NO_CONTENT).send({ });

          ctx.bus.emit('storage-socket-update', { colName: col.colName, doc });
          col.autoPrune();
          ctx.bus.emit('data-received');
        });

      } catch (err) {
        console.error(err);
        return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }


    async function create (authorization) {

      try {
        const doc = req.body;
        col.parseDate(doc);

        if (validate(doc) == null) 
          return;

        const identifyingFilter = col.storage.identifyingFilter(doc.identifier, doc, col.dedupFallbackFields);

        const result = await col.storage.findOneFilter(identifyingFilter, { });

        if (!result) 
          throw 'empty result';

        if (result.length > 0) {
          replace(doc, result[0], authorization);
        }
        else {
          insert(doc, authorization);
        }

      } catch (err) {
        console.error(err);
        return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }


    col.authorizers.create(req, res, create);
  }
}

module.exports = CreateOperation;