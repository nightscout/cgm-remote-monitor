'use strict';

const _ = require('lodash')
  , apiConst = require('../const.json')
  , dateTools = require('../shared/dateTools')
  , stringTools = require('../shared/stringTools')

/**
  * PATCH: Partially updates document in the collection
  */
function PatchOperation (ctx, env, app, col) {

  const self = this;
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

      if (typeof(doc.date) !== 'undefined' && 
        (typeof(doc.date) !== 'number' || doc.date <= apiConst.MIN_TIMESTAMP)) {
        res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_FIELD_DATE);
        return null;
      }

      if (typeof(doc.utcOffset) !== 'undefined' && 
        (typeof(doc.utcOffset) !== 'number' 
          || doc.utcOffset < apiConst.MIN_UTC_OFFSET || doc.utcOffset > apiConst.MAX_UTC_OFFSET)) {
        res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_FIELD_UTC);
        return null;
      }

      if (typeof(doc.app) !== 'undefined' && 
        (typeof(doc.app) !== 'string' || stringTools.isNullOrWhitespace(doc.app))) {
        res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_FIELD_APP);
        return null;
      }

      return true;
    }


    /**
     * Patch existing document in the collection
     * @param {any} doc - fields and values to patch
     */
    async function applyPatch (identifier, doc, authorization) {
      try {
        const now = new Date;
        doc.srvModified = now.getTime();

        if (authorization && authorization.subject && authorization.subject.name) {
          doc.userModified = authorization.subject.name;
        }

        const matchedCount = await col.storage.updateOne(identifier, doc);

        if (!matchedCount) 
          throw 'matchedCount empty';

        res.setHeader('Last-Modified', now.toUTCString());
        res.status(apiConst.HTTP.NO_CONTENT).send({ });
        col.autoPrune();
        ctx.bus.emit('data-received');

      } catch(err) {
        console.error(err);
        return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }


    async function patch (authorization) {
      try {
        const doc = req.body;
        col.parseDate(doc);

        if (validate(doc) == null) 
          return;

        const identifier = req.params.identifier
          , identifyingFilter = col.storage.identifyingFilter(identifier);

        const result = await col.storage.findOneFilter(identifyingFilter, { });

        if (!result) 
          throw 'result empty';

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

          applyPatch(identifier, doc, authorization);
        }
        else {
          return res.status(apiConst.HTTP.NOT_FOUND).end();
        }

      } catch(err) {
        console.error(err);
        return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }

    col.authorizers.update(req, res, patch);
  }
}

module.exports = PatchOperation;