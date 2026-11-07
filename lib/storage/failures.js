'use strict';

// Storage dependency recognition only; transport status and document validation
// provenance belong to the caller. Preserve wrapped failures and cause cycles.
const UNAVAILABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03', '53300', '42501']);

function isUnavailable (error) {
  const seen = new Set();
  for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    if (UNAVAILABLE.has(cause.code) || (typeof cause.code === 'string' && /^08[0-9A-Z]{3}$/.test(cause.code))) return true;
  }
  return false;
}

module.exports = { isUnavailable };
