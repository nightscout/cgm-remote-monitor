'use strict';

// HTTP/socket admission by activity (decision activity-adopted-semantics-wiring):
//   suspended  refuses everything, uploads and reads alike;
//   paused     refuses reads and the web UI; uploads continue.
// An upload is a write method (POST, PUT, PATCH, DELETE), a CORS preflight, or
// the credential exchange (GET /api/v2/authorization/request/:token) that
// uploaders use before writing. A forwarded socket operation without a request
// is admitted as an upload: the realtime role itself refuses paused sockets.
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const EXCHANGE = /^\/api\/v2\/authorization\/request\/[^/]+\/?$/;
const refuse = code => Object.assign(new Error(code), { code });

function operationOf (req) {
  if (!req) return 'ingest';
  if (WRITE.has(req.method)) return 'ingest';
  const path = typeof req.path === 'string' ? req.path : String(req.url || '').split('?')[0];
  return req.method === 'GET' && EXCHANGE.test(path) ? 'ingest' : 'read';
}

function createServingGate ({ check } = {}) {
  if (typeof check !== 'function') throw new TypeError('Activity eligibility required');
  return async function admit (tenant, req) {
    const checked = await check(operationOf(req), tenant);
    if (checked.eligible) return checked;
    throw refuse(checked.state === 'suspended' ? 'TENANT_SUSPENDED' : checked.state === 'paused' ? 'TENANT_PAUSED' : 'TENANT_ACTIVITY_UNAVAILABLE');
  };
}

// Realtime: every readCurrent (socket admission, each socket operation, alarm
// delivery, each recovery refresh) first reads the durable state. A paused or
// suspended tenant reads as disabled and its open sockets are disconnected.
function gateReadCurrent ({ check, readCurrent, invalidate } = {}) {
  if ([check, readCurrent, invalidate].some(fn => typeof fn !== 'function')) throw new TypeError('Activity realtime gate requires eligibility, config and invalidation');
  return async function gatedReadCurrent (tenant) {
    const checked = await check('read', tenant);
    if (!checked.eligible) { invalidate(tenant); return null; }
    return readCurrent(tenant);
  };
}

module.exports = { createServingGate, gateReadCurrent, operationOf };
