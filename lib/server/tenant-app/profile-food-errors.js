'use strict';

const { isUnavailable } = require('../../storage/failures');
const submitted = new WeakSet();

module.exports = function options (step) {
  function validate (method, doc) {
    try { step.storage[method](doc); } catch (error) {
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
    storage: step.storage,
    intentFactory: () => ({
      ...step,
      async write (intent) {
        if (intent.docs) intent.docs.forEach(doc => validate('validateDocument', doc));
        return step.write(intent);
      }
    }),
    validateCreate: doc => validate('validateDocument', doc),
    validatePatch: doc => validate('validatePatch', doc),
    createError: storageError,
    storageError
  };
};
