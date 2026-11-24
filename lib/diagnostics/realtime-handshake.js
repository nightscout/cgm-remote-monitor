'use strict';

// Engine.IO returns the same public 403 for these distinct admission failures.
// Keep the existing private counters useful without logging arbitrary error
// codes, request fields, tenant identities or credentials.
const CODES = Object.freeze(['REALTIME_ORIGIN_REFUSED', 'SOCKET_ADMISSION_REFUSED',
  'SOCKET_ADMISSION_UNAVAILABLE', 'PLATFORM_VERIFICATION_REQUIRED',
  'REALTIME_OWNER_UNAVAILABLE', 'REALTIME_WRONG_OWNER',
  'REALTIME_HANDSHAKE_REFUSED', 'UNCLASSIFIED']);
const known = new Set(CODES);
function counts (raw) {
  const result = {};
  for (const [code, count] of Object.entries(raw || {})) {
    if (!Number.isSafeInteger(count) || count < 1) continue;
    const category = known.has(code) ? code : code.startsWith('REALTIME_HANDSHAKE_REFUSED:') ? 'REALTIME_HANDSHAKE_REFUSED' : 'UNCLASSIFIED';
    result[category] = Math.min(Number.MAX_SAFE_INTEGER, (result[category] || 0) + count);
  }
  return result;
}
module.exports = { counts, CODES };
