'use strict';

/**
 * Storage implementation using mongoDB
 * @param {string} colName - name of the collection in mongo database
 */
function configure (ctx, env, colName) {

  var storage = { }
    , ObjectID = require('mongodb').ObjectID
    , checkForHexRegExp = new RegExp("^[0-9a-fA-F]{24}$")
    , _each = require('lodash/each')

  storage.colName = colName;

  storage.col = ctx.store.collection(colName);

  ctx.store.ensureIndexes(storage.col, [ 'identifier', 
    'srvModified',
    'isValid'
  ]);


  /**
   * Normalize document (make it mongoDB independent)
   * @param {any} doc - document loaded from mongoDB
   */
  storage.normalizeDoc = function normalizeDoc (doc) {
    if (!doc.identifier) {
      doc.identifier = doc._id.toString();
    }

    delete doc._id;
  };


  /**
   * Create query filter for single document with identifier fallback 
   * @param {any} identifier
   */
  storage.filterForOne = function filterForOne (identifier) {

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
  storage.findOne = function findOne (identifier, projection, done) {
    
    var filter = storage.filterForOne(identifier);

    storage.col.find(filter)
      .project(projection)
      .sort({ identifier: -1 }) // document with identifier first (not the fallback one)
      .toArray(function loaded (err, result) {

        _each(result, storage.normalizeDoc);
        done(err, result);
      });
  }


  /**
   * Update single document by identifier
   * @param {string} identifier
   * @param {object} setFields
   * @param {function} done
   */
  storage.updateOne = function updateOne (identifier, setFields, done) {
    
    var filter = storage.filterForOne(identifier);

    storage.col.updateOne(filter, { $set: setFields }, function updateOneFinished (err, result) {
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
  storage.deleteOne = function deleteOne (identifier, done) {

    var filter = storage.filterForOne(identifier);

    storage.col.deleteOne(filter, function deleteOneFinished (err, result) {
      if (err) {
        done(err, null);
      }
      else {
        done(err, { deleted: result.result.n });
      }
    });
  }


  return storage;
}

module.exports = configure;