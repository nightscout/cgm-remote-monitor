'use strict';

/**
 * Storage implementation using mongoDB
 * @param {string} colName - name of the collection in mongo database
 */
function MongoCollection (ctx, env, colName) {

  var self = this
    , ObjectID = require('mongodb').ObjectID
    , checkForHexRegExp = new RegExp("^[0-9a-fA-F]{24}$")
    , _ = require('lodash')

  self.colName = colName;

  self.col = ctx.store.collection(colName);

  ctx.store.ensureIndexes(self.col, [ 'identifier', 
    'srvModified',
    'isValid'
  ]);


  /**
   * Parse filter definition array into mongoDB filtering object
   * @param {Array} filterDef
   */
  var parseFilter = function parseFileter (filterDef) {
    var filter = { }
    if (filterDef) {
      var filterDefLength = filterDef.length;
      for (var i = 0; i < filterDefLength; i++) {
        var item = filterDef[i];

        switch (item.operator) {
          case 'eq':
            filter[item.field] = item.value;
            break;

          case 'ne':
            filter[item.field] = { $ne: item.value };
            break;

          case 'gt':
            filter[item.field] = { $gt: item.value };
            break;

          case 'gte':
            filter[item.field] = { $gte: item.value };
            break;

          case 'lt':
            filter[item.field] = { $lt: item.value };
            break;

          case 'lte':
            filter[item.field] = { $lte: item.value };
            break;

          case 'in':
            filter[item.field] = { $in: item.value.toString().split('|') };
            break;

          case 'nin':
            filter[item.field] = { $nin: item.value.toString().split('|') };
            break;

          case 're':
            filter[item.field] = { $regex: item.value.toString() };
            break;

          default: 
            throw 'Unsupported or missing filter operator ' + item.operator;
        }
      }
    }

    return filter;
  }


  /**
   * Normalize document (make it mongoDB independent)
   * @param {Object} doc - document loaded from mongoDB
   */
  self.normalizeDoc = function normalizeDoc (doc) {
    if (!doc.identifier) {
      doc.identifier = doc._id.toString();
    }

    delete doc._id;
  };


  /**
   * Create query filter to check whether the document already exists in the storage. 
   * This function resolves eventual fallback deduplication.
   * @param {string} identifier - identifier of document to check its existence in the storage
   * @param {Object} doc - document to check its existence in the storage
   * @param {Array} dedupFallbackFields - fields that all need to be matched to identify document via fallback deduplication
   * @returns {Object} doc - query filter for mongo or null in case of no identifying possibility
   */
  self.identifyingFilter = function identifyingFilter(identifier, doc, dedupFallbackFields) {

    var filterItems = [];

    if (identifier) {
      // standard identifier field (APIv3)
      filterItems.push({ identifier: identifier });

      // fallback to "identifier = _id" (APIv1)
      if (checkForHexRegExp.test(identifier)) {
        filterItems.push({ identifier: { $exists: false }, _id: ObjectID(identifier) });
      }
    }

    // let's deal with eventual fallback deduplication
    if (!_.isEmpty(doc) && _.isArray(dedupFallbackFields) && dedupFallbackFields.length > 0) {
      var dedupFilterItems = [];

      _.each(dedupFallbackFields, function addDedupField (field) {

        if (doc[field] !== undefined) {

          var dedupFilterItem = { };
          dedupFilterItem[field] = doc[field];
          dedupFilterItems.push(dedupFilterItem);
        }
      });

      if (dedupFilterItems.length === dedupFallbackFields.length) { // all dedup fields are present

        dedupFilterItems.push({ identifier: { $exists: false } }); // force not existing identifier for fallback deduplication
        filterItems.push({ $and: dedupFilterItems });
      }
    }

    if (filterItems.length > 0) 
      return { $or: filterItems }
    else 
      return null; // we don't have any filtering rule to identify the document in the storage
  }
  
  
  /**
   * Create query filter for single document with identifier fallback 
   * @param {any} identifier
   */
  self.filterForOne = function filterForOne (identifier) {

    var filterOpts = [ { identifier: identifier } ];
    
    // fallback to "identifier = _id"
    if (checkForHexRegExp.test(identifier)) {
        filterOpts.push({ _id: ObjectID(identifier) });
    }

    return { $or: filterOpts };
  }


  /**
   * Find single document by identifier
   * @param {string} identifier
   * @param {function} done
   */
  self.findOne = function findOne (identifier, projection, done) {
    
    var filter = self.filterForOne(identifier);

    self.col.find(filter)
      .project(projection)
      .sort({ identifier: -1 }) // document with identifier first (not the fallback one)
      .toArray(function loaded (err, result) {

        _.each(result, self.normalizeDoc);
        done(err, result);
      });
  }


  /**
   * Find single document by query filter
   * @param {Object} specific filter
   * @param {function} done
   */
  self.findOneFilter = function findOneFilter (filter, projection, done) {
    
    self.col.find(filter)
      .project(projection)
      .sort({ identifier: -1 }) // document with identifier first (not the fallback one)
      .toArray(function loaded (err, result) {

        _.each(result, self.normalizeDoc);
        done(err, result);
      });
  }


  /**
   * Find many documents matching the filtering criteria
   * @param {function} done
   */
  self.findMany = function findMany (filterDef, sort, limit, skip, projection, done) {

    var filter = parseFilter(filterDef);

    self.col.find(filter)
      .sort(sort)
      .limit(limit)
      .skip(skip)
      .project(projection)
      .toArray(function loaded(err, result) {

        _.each(result, self.normalizeDoc);
        done(err, result);
      });
  }


  /**
   * Insert single document 
   * @param {Object} doc
   * @param {function} done - done (err, identifier)
   */
  self.insertOne = function insertOne (doc, done) {
    
    self.col.insertOne(doc, function insertDone (err, result) {

      if (err) {
        done(err, null);
      }
      else {
        var identifier = doc.identifier || result.insertedId.toString();
        done(null, identifier);
      }
    });
  }


  /**
   * Replace single document 
   * @param {Object} identifier
   * @param {Object} doc
   * @param {function} done
   */
  self.replaceOne = function replaceOne (identifier, doc, done) {
    
    var filter = self.filterForOne(identifier);

    self.col.replaceOne(filter, doc, { }, function (err, result) {
      done(err, result.matchedCount);
    });
  }


  /**
   * Update single document by identifier
   * @param {string} identifier
   * @param {object} setFields
   * @param {function} done
   */
  self.updateOne = function updateOne (identifier, setFields, done) {
    
    var filter = self.filterForOne(identifier);

    self.col.updateOne(filter, { $set: setFields }, function updateOneFinished (err, result) {
      if (err) {
        done(err, null);
      }
      else {
        done(err, { updated: result.result.nModified });
      }
    });
  }


  /**
   * Permanently remove single document by identifier
   * @param {string} identifier
   * @param {function} done
   */
  self.deleteOne = function deleteOne (identifier, done) {

    var filter = self.filterForOne(identifier);

    self.col.deleteOne(filter, function deleteOneFinished (err, result) {
      if (err) {
        done(err, null);
      }
      else {
        done(err, { deleted: result.result.n });
      }
    });
  }
}

module.exports = MongoCollection;