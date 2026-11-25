'use strict';

const collectionIntent = require('../../storage/postgres-collection-intent');
const submitted = new WeakSet();
const sendUnavailable = require('./storage-unavailable');

// Trusted constructor options; no schema creation or request-selected table.
// naturalOrder: the table carries insertion_ordinal (the socket-order
// catalogue); the v1 port then reads and replaces in insertion order (INC-P).
module.exports = function treatments ({ connection, table = 'treatments', bus, env = {}, source = 'v3', naturalOrder = false, catalogue } = {}) {
  if (naturalOrder !== false && (naturalOrder !== true || source !== 'v1/internal')) throw new TypeError('Treatments natural order requires the v1 port');
  const ordered = catalogue?.migrations.some(m => m.operation?.kind === 'tenant-insertion-v1');
  const step = collectionIntent({ connection, table, logical: 'treatments', bus, env, source, naturalOrder,
    tieBreak: ordered ? 'insertion_ordinal' : undefined });
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
    return sendUnavailable(error, res);
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
