'use strict';

/**
 * Storage implementation using mongoDB
 * @param {string} colName - name of the collection in mongo database
 */
function MongoCollection (ctx, env, colName) {

  const self = this
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
  self.identifyingFilter = function identifyingFilter (identifier, doc, dedupFallbackFields) {

    const filterItems = [];

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

    const filterOpts = [ { identifier: identifier } ];
    
    // fallback to "identifier = _id"
    if (checkForHexRegExp.test(identifier)) {
        filterOpts.push({ _id: ObjectID(identifier) });
    }

    return { $or: filterOpts };
  }


  /**
   * Get server version
   */
  self.version = function version () {

    return new Promise(function (resolve, reject) {

      ctx.store.db.admin().buildInfo({}, function mongoDone (err, result) {

        err
          ? reject(err)
          : resolve({
            storage: 'mongodb',
            version: result.version
          });
      });
    });
  }


  /**
   * Find single document by identifier
   * @param {string} identifier
   */
  self.findOne = function findOne (identifier, projection) {
    
    return new Promise(function (resolve, reject) {

      const filter = self.filterForOne(identifier);

      self.col.find(filter)
      .project(projection)
      .sort({ identifier: -1 }) // document with identifier first (not the fallback one)
      .toArray(function mongoDone (err, result) {

        if (err) {
          reject(err);
        } else {
          _.each(result, self.normalizeDoc);
          resolve(result);
        }
      });
    });
  }


  /**
   * Find single document by query filter
   * @param {Object} specific filter
   */
  self.findOneFilter = function findOneFilter (filter, projection) {
    
    return new Promise(function (resolve, reject) {

      self.col.find(filter)
      .project(projection)
      .sort({ identifier: -1 }) // document with identifier first (not the fallback one)
      .toArray(function mongoDone (err, result) {

        if (err) {
          reject(err);
        } else {
          _.each(result, self.normalizeDoc);
          resolve(result);
        }
      });
    });
  }


  /**
   * Parse filter definition array into mongoDB filtering object
   * @param {any} filterDef
   */
  const parseFilter = function parseFilter (filterDef, logicalOperator, onlyValid) {
    
    let filter = { }
    if (!filterDef) 
      return filter;

    if (!_.isArray(filterDef)) {
      return filterDef;
    }

    let clauses = [];

    for (const itemDef of filterDef) {
      let item;

      switch (itemDef.operator) {
        case 'eq':
          item = itemDef.value;
          break;

        case 'ne':
          item = { $ne: itemDef.value };
          break;

        case 'gt':
          item = { $gt: itemDef.value };
          break;

        case 'gte':
          item = { $gte: itemDef.value };
          break;

        case 'lt':
          item = { $lt: itemDef.value };
          break;

        case 'lte':
          item = { $lte: itemDef.value };
          break;

        case 'in':
          item = { $in: itemDef.value.toString().split('|') };
          break;

        case 'nin':
          item = { $nin: itemDef.value.toString().split('|') };
          break;

        case 're':
          item = { $regex: itemDef.value.toString() };
          break;

        default: 
          throw 'Unsupported or missing filter operator ' + itemDef.operator;
      }

      if (logicalOperator === 'or') {
        var clause = { };
        clause[itemDef.field] = item;
        clauses.push(clause);
      }
      else {
        filter[itemDef.field] = item;
      }
    }

    if (logicalOperator === 'or') {
      filter = { $or: clauses };
    }

    if (onlyValid) {
      filter.isValid = { $ne: false };
    }

    return filter;
  }


  /**
   * Find many documents matching the filtering criteria
   */
  self.findMany = function findMany (filterDef, sort, limit, skip, projection, onlyValid, logicalOperator = 'and') {

    return new Promise(function (resolve, reject) {

      const filter = parseFilter(filterDef, logicalOperator, onlyValid);

      self.col.find(filter)
      .sort(sort)
      .limit(limit)
      .skip(skip)
      .project(projection)
      .toArray(function mongoDone (err, result) {

        if (err) {
          reject(err);
        } else {
          _.each(result, self.normalizeDoc);
          resolve(result);
        }
      });
    });
  }


  /**
   * Get timestamp (e.g. srvModified) of the last modified document 
   */
  self.getLastModified = function getLastModified (fieldName) {
    
    return new Promise(function (resolve, reject) {

      self.col.find()

        .sort({ [fieldName]: -1 })

        .limit(1)

        .project({ [fieldName]: 1 })

        .toArray(function mongoDone (err, [ result ]) {
          err
            ? reject(err)
            : resolve(result);
        });
    });
  }


  /**
   * Insert single document 
   * @param {Object} doc
   */
  self.insertOne = function insertOne (doc) {
    
    return new Promise(function (resolve, reject) {

        self.col.insertOne(doc, function mongoDone(err, result) {

          if (err) {
            reject(err);
          } else {
            const identifier = doc.identifier || result.insertedId.toString();
            resolve(identifier);
          }
        });
    });
  }


  /**
   * Replace single document 
   * @param {Object} identifier
   * @param {Object} doc
   */
  self.replaceOne = function replaceOne (identifier, doc) {
    
    return new Promise(function (resolve, reject) {

      const filter = self.filterForOne(identifier);

      self.col.replaceOne(filter, doc, { }, function mongoDone(err, result) {
        if (err) {
          reject(err);
        } else {
          resolve(result.matchedCount);
        }
      });
    });
  }


  /**
   * Update single document by identifier
   * @param {string} identifier
   * @param {object} setFields
   */
  self.updateOne = function updateOne (identifier, setFields) {
    
    return new Promise(function (resolve, reject) {

      const filter = self.filterForOne(identifier);

      self.col.updateOne(filter, { $set: setFields }, function mongoDone(err, result) {
        if (err) {
          reject(err);
        } else {
          resolve({ updated: result.result.nModified });
        }
      });
    });
  }


  /**
   * Permanently remove single document by identifier
   * @param {string} identifier
   */
  self.deleteOne = function deleteOne (identifier) {

    return new Promise(function (resolve, reject) {

      const filter = self.filterForOne(identifier);

      self.col.deleteOne(filter, function mongoDone(err, result) {
        if (err) {
          reject(err);
        } else {
          resolve({ deleted: result.result.n });
        }
      });
    });
  }


  /**
   * Permanently remove many documents matching any of filtering criteria
   */
  self.deleteManyOr = function deleteManyOr (filterDef) {

    return new Promise(function (resolve, reject) {

      const filter = parseFilter(filterDef, 'or');

      self.col.deleteMany(filter, function mongoDone(err, result) {
        if (err) {
          reject(err);
        } else {
          resolve({ deleted: result.deletedCount });
        }
      });
    });
  }
}

module.exports = MongoCollection;