'use strict';

const entriesIntent = require('../../storage/postgres-entries-intent');
const submitted = new WeakSet();
const UNAVAILABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03', '53300', '42501']);

// Trusted Collection constructor options, never selected by a request.
module.exports = function entries ({ connection, table, bus, env } = {}) {
  const step = entriesIntent({ connection, table, bus, env });
  return {
    storage: step.storage,
    intentFactory: () => step,
    validateCreate (doc) {
      try {
        step.storage.validateDocument(doc);
      } catch (error) {
        if (error.unsupported === true) submitted.add(error);
        throw error;
      }
    },
    createError (error, res) {
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
  };
};
