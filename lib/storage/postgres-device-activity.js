'use strict';

const collectionIntent = require('./postgres-collection-intent');
const UNAVAILABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03', '53300', '42501']);

module.exports = function deviceActivity ({ logical, source, connection, table, bus, env }) {
  if (!['devicestatus', 'activity'].includes(logical) ||
      !['v3', 'v1/internal'].includes(source) || (logical === 'activity' && source !== 'v1/internal')) {
    throw new TypeError('Unsupported device/activity collection source');
  }
  const step = collectionIntent({ logical, source, connection, table, bus, env });
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
    const seen = new Set();
    for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
      seen.add(cause);
      if (UNAVAILABLE.has(cause.code) || (typeof cause.code === 'string' && /^08[0-9A-Z]{3}$/.test(cause.code))) {
        res.status(503).json({ error: 'STORAGE_UNAVAILABLE' });
        return true;
      }
    }
    return false;
  }
  return {
    storage: step.storage,
    intentFactory: () => step,
    validateCreate: doc => validate('validateDocument', doc),
    validatePatch: doc => validate('validatePatch', doc),
    createError: storageError,
    storageError
  };
};
