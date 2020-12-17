'use strict';

/**
 * Storage implementation which wraps baseStorage with caching
 * @param {Object} ctx
 * @param {Object} env
 * @param {string} colName - name of the collection in mongo database
 * @param {Object} baseStorage - wrapped storage implementation
 */
function CachedCollection (ctx, env, colName, baseStorage) {

  const self = this;

  self.colName = colName;

  self.identifyingFilter = baseStorage.identifyingFilter;

  self.findOne = (...args) => baseStorage.findOne(...args);

  self.findOneFilter = (...args) => baseStorage.findOneFilter(...args);

  self.findMany = (...args) => baseStorage.findMany(...args);

  self.insertOne = (...args) => baseStorage.insertOne(...args);

  self.replaceOne = (...args) => baseStorage.replaceOne(...args);

  self.updateOne = (...args) => baseStorage.updateOne(...args);

  self.deleteOne = (...args) => baseStorage.deleteOne(...args);

  self.deleteManyOr = (...args) => baseStorage.deleteManyOr(...args);

  self.version = (...args) => baseStorage.version(...args);

  self.getLastModified = (...args) => baseStorage.getLastModified(...args);

}

module.exports = CachedCollection;
