'use strict';

const { unavailableCause } = require('../../storage/failures');

// A PostgreSQL refusal that committed nothing (postgres-connection: a statement
// missed its local deadline, or no pooled client came free in time) is
// answered as the API v1 entries route answers it: its own code and
// Retry-After. Other outages stay STORAGE_UNAVAILABLE.
const REFUSALS = new Set(['STORAGE_TIMEOUT', 'STORAGE_BUSY']);

module.exports = function sendUnavailable (error, res) {
  const cause = unavailableCause(error);
  if (!cause) return false;
  const refusal = REFUSALS.has(cause.code);
  if (cause.code === 'LIFECYCLE_WINDOW_SUSPENDED' || (refusal && Number.isSafeInteger(cause.retryAfter) && cause.retryAfter > 0)) {
    res.set('Retry-After', String(cause.retryAfter));
  }
  res.status(503).json({ error: refusal ? cause.code : 'STORAGE_UNAVAILABLE' });
  return true;
};
