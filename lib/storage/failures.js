'use strict';

// Storage dependency recognition only; transport status and document validation
// provenance belong to the caller. Preserve wrapped failures and cause cycles.
// STORAGE_TIMEOUT and STORAGE_BUSY are PostgreSQL connection refusals that
// committed nothing (lib/storage/postgres-connection.js).
const UNAVAILABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03', '53300', '42501',
  'STORAGE_TIMEOUT', 'STORAGE_BUSY']);

function unavailableCause (error) {
  const seen = new Set();
  for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    if (cause.code === 'LIFECYCLE_WINDOW_SUSPENDED' && require('../tenant-lifecycle/generation-scope').isSuspension(cause)) return cause;
    if (UNAVAILABLE.has(cause.code) || (typeof cause.code === 'string' && /^08[0-9A-Z]{3}$/.test(cause.code))) return cause;
  }
  return null;
}

function isUnavailable (error) { return unavailableCause(error) !== null; }

module.exports = { isUnavailable, unavailableCause };
