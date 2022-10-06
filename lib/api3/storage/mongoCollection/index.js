'use strict';

/**
 * Storage implementation using mongoDB
 * @param {Object} ctx
 * @param {Object} env
 * @param {string} colName - name of the collection in mongo database
 */
function MongoCollection (ctx, env, colName) {

  const self = this
    , utils = require('./utils')
    , find = require('./find')
    , modify = require('./modify')
    ;

  self.colName = colName;

  self.col = ctx.store.collection(colName);

  ctx.store.ensureIndexes(self.col, [ 'identifier',
    'srvModified',
    'isValid'
  ]);


  self.identifyingFilter = utils.identifyingFilter;

  self.findOne = (...args) => find.findOne(self.col, ...args);

  self.findOneFilter = (...args) => find.findOneFilter(self.col, ...args);

  self.findMany = (...args) => find.findMany(self.col, ...args);

  self.insertOne = (...args) => modify.insertOne(self.col, ...args);

  self.replaceOne = (...args) => modify.replaceOne(self.col, ...args);

  self.updateOne = (...args) => modify.updateOne(self.col, ...args);

  self.deleteOne = (...args) => modify.deleteOne(self.col, ...args);

  self.deleteManyOr = (...args) => modify.deleteManyOr(self.col, ...args);


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
  };


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
}

module.exports = MongoCollection;
