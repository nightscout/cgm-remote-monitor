'use strict';

const _ = require('lodash')
  , apiConst = require('../../const.json')
  , security = require('../../security')
  , validate = require('./validate.js')
  , insert = require('./insert')
  , opTools = require('../../shared/operationTools')
  ;

/**
  * CREATE: Inserts a new document into the collection
  */
function createOperation (ctx, env, app, col) {

  async function operation (req, res) {
    


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
            throw new Error('empty matchedCount');

          const identifier = doc.identifier || storageDoc.identifier;

          res.setHeader('Last-Modified', now.toUTCString());
          res.setHeader('Location', `${req.baseUrl}${req.path}/${identifier}`);
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


    async function create (opCtx) {

      const { auth } = opCtx;
      const doc = req.body;
      col.parseDate(doc);

      if (validate.validateBasic(doc, opCtx) !== true)
        return;

      const identifyingFilter = col.storage.identifyingFilter(doc.identifier, doc, col.dedupFallbackFields);

      const result = await col.storage.findOneFilter(identifyingFilter, { });

      if (!result)
        throw new Error('empty result');

      if (result.length > 0) {
        replace(doc, result[0], auth);
      }
      else {
        await insert(opCtx, doc);
      }
    }


    const opCtx = { app, ctx, env, col, req, res };

    try {
      opCtx.auth = await security.authenticate(opCtx);

      await create(opCtx);

    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        return opTools.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }
  }

  return operation;
}

module.exports = createOperation;