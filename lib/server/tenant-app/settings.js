'use strict';

const collectionIntent = require('../../storage/postgres-collection-intent');
const { isUnavailable } = require('../../storage/failures');

// API3 settings documents are not tenant-owner configuration or secrets.
module.exports = function settings ({ connection, table, bus, env, source = 'v3' } = {}) {
  if (source !== 'v3') throw new TypeError('Settings documents have only an API3 contract');
  const step = collectionIntent({ connection, table, logical: 'settings', bus, env, source });
  const submitted = new WeakSet();
  function validate (method, doc) {
    try {
      step.storage[method](doc);
    } catch (error) {
      if (error.unsupported === true) submitted.add(error);
      throw error;
    }
  }
  function storageError (error, res) {
    if (submitted.has(error)) {
      res.status(400).json({ status: 400, message: 'Document cannot be represented by this storage' });
      return true;
    }
    if (isUnavailable(error)) {
      res.status(503).json({ error: 'STORAGE_UNAVAILABLE' });
      return true;
    }
    return false;
  }
  return {
    storage: step.storage, intentFactory: () => step,
    validateCreate: doc => validate('validateDocument', doc),
    validatePatch: doc => validate('validatePatch', doc),
    createError: storageError, storageError
  };
};
