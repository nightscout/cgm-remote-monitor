'use strict';

const apiConst = require('../const.json')
  , _ = require('lodash')
  , dateTools = require('../shared/dateTools')
  , opTools = require('../shared/operationTools')
  , stringTools = require('../shared/stringTools')
  , CollectionStorage = require('../storage/mongoCollection')
  , searchOperation = require('./search/operation')
  , createOperation = require('./create/operation')
  , readOperation = require('./read/operation')
  , updateOperation = require('./update/operation')
  , patchOperation = require('./patch/operation')
  , deleteOperation = require('./delete/operation')
  , historyOperation = require('./history/operation')
  ;

/**
  * Generic collection (abstraction over each collection specifics)
  * @param {string} colName - name of the collection inside the storage system
  * @param {function} fallbackGetDate - function that tries to create srvModified virtually from other fields of document
  * @param {Array} dedupFallbackFields - fields that all need to be matched to identify document via fallback deduplication
  * @param {function} fallbackHistoryFilter - function that creates storage filter for all newer records (than the timestamp from first function parameter)
  */
function Collection ({ ctx, env, app, colName, storageColName, fallbackGetDate, dedupFallbackFields,
    fallbackDateField }) {

  const self = this;
    
  self.colName = colName;
  self.fallbackGetDate = fallbackGetDate;
  self.dedupFallbackFields = app.get('API3_DEDUP_FALLBACK_ENABLED') ? dedupFallbackFields : [];
  self.autoPruneDays = app.setENVTruthy('API3_AUTOPRUNE_' + colName.toUpperCase());
  self.nextAutoPrune = new Date();
  self.storage = new CollectionStorage(ctx, env, storageColName);
  self.fallbackDateField = fallbackDateField;

  self.mapRoutes = function mapRoutes () {
    const prefix = '/' + colName
      , prefixId = prefix + '/:identifier'
      , prefixHistory = prefix + '/history'
      ;


    // GET /{collection}
    app.get(prefix, searchOperation(ctx, env, app, self));

    // POST /{collection}
    app.post(prefix, createOperation(ctx, env, app, self));

    // GET /{collection}/history
    app.get(prefixHistory, historyOperation(ctx, env, app, self));

    // GET /{collection}/history
    app.get(prefixHistory + '/:lastModified', historyOperation(ctx, env, app, self));

    // GET /{collection}/{identifier}
    app.get(prefixId, readOperation(ctx, env, app, self));

    // PUT /{collection}/{identifier}
    app.put(prefixId, updateOperation(ctx, env, app, self));

    // PATCH /{collection}/{identifier}
    app.patch(prefixId, patchOperation(ctx, env, app, self));

    // DELETE /{collection}/{identifier}
    app.delete(prefixId, deleteOperation(ctx, env, app, self));
  };


  /**
    * Parse limit (max document count) from query string
    */
  self.parseLimit = function parseLimit (req, res) {
    const maxLimit = app.get('API3_MAX_LIMIT');
    let limit = maxLimit;

    if (req.query.limit) {
      if (!isNaN(req.query.limit) && req.query.limit > 0 && req.query.limit <= maxLimit) {
        limit = parseInt(req.query.limit);
      }
      else {
        opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_LIMIT);
        return null;
      }
    }

    return limit;
  };


  
  /**
    * Fetch modified date from document (with possible fallback and back-fill to srvModified/srvCreated) 
    * @param {Object} doc - document loaded from database
    */
  self.resolveDates = function resolveDates (doc) {
    let modifiedDate;
    try {
      if (doc.srvModified) {
        modifiedDate = new Date(doc.srvModified);
      }
      else {
        if (typeof (self.fallbackGetDate) === 'function') {
          modifiedDate = self.fallbackGetDate(doc);
          if (modifiedDate) {
            doc.srvModified = modifiedDate.getTime();
          }
        }
      }

      if (doc.srvModified && !doc.srvCreated) {
        doc.srvCreated = modifiedDate.getTime();
      }
    }
    catch (error) {
      console.warn(error);
    }
    return modifiedDate;
  };


  /**
   * Deletes old documents from the collection if enabled (for this collection)
   * in the background (asynchronously)
   * */
  self.autoPrune = function autoPrune () {
    
    if (!stringTools.isNumberInString(self.autoPruneDays))
      return;
    
    const autoPruneDays = parseFloat(self.autoPruneDays);
    if (autoPruneDays <= 0) 
      return;

    if (new Date() > self.nextAutoPrune) {

      const deleteBefore = new Date(new Date().getTime() - (autoPruneDays * 24 * 3600 * 1000));

      const filter =  [
        { field: 'srvCreated', operator: 'lt', value: deleteBefore.getTime() },
        { field: 'created_at', operator: 'lt', value: deleteBefore.toISOString() },
        { field: 'date', operator: 'lt', value: deleteBefore.getTime() }
      ];

      // let's autoprune asynchronously (we won't wait for the result)
      self.storage.deleteManyOr(filter, function deleteDone (err, result) {
        if (err || !result) {
          console.error(err);
        }

        if (result.deleted) {
          console.info('Auto-pruned ' + result.deleted + ' documents from ' + self.colName + ' collection ');
        }
      });

      self.nextAutoPrune = new Date(new Date().getTime() + (3600 * 1000));
    }
  };


  /**
    * Parse date and utcOffset + optional created_at fallback
    * @param {Object} doc
    */
  self.parseDate = function parseDate (doc) {
    if (!_.isEmpty(doc)) {

      let values = app.get('API3_CREATED_AT_FALLBACK_ENABLED')
        ? [doc.date, doc.created_at]
        : [doc.date];

      let m = dateTools.parseToMoment(values);
      if (m && m.isValid()) {
        doc.date = m.valueOf();

        if (typeof doc.utcOffset === 'undefined') {
          doc.utcOffset = m.utcOffset();
        }

        if (app.get('API3_CREATED_AT_FALLBACK_ENABLED')) {
          doc.created_at = m.toISOString();
        }
        else {
          if (doc.created_at)
            delete doc.created_at;
        }
      }
    }
  }
}

module.exports = Collection;